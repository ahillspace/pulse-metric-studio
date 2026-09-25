#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod credential_broker;

use serde::Deserialize;
use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::ipc::CapabilityBuilder;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{StateFlags, WindowExt};

use credential_broker::{
    start_credential_broker, tableau_credential_capability, tableau_delete_credential,
    tableau_replace_credential, tableau_store_credential, CredentialBrokerHandle,
    CredentialContext,
};
use uuid::Uuid;

const DEFAULT_SERVER_PORT: u16 = 4620;

struct ServerHandle(Mutex<Option<Child>>);

#[derive(Clone, Debug)]
struct DesktopIdentity {
    product_name: String,
    identifier: String,
    log_slug: String,
}

impl DesktopIdentity {
    fn from_app(app: &AppHandle) -> Self {
        let product_name = app
            .config()
            .product_name
            .clone()
            .unwrap_or_else(|| "Pulse Metric Studio".to_string());
        let identifier = app.config().identifier.clone();
        Self {
            log_slug: slug(&product_name),
            product_name,
            identifier,
        }
    }
}

fn slug(value: &str) -> String {
    let mut result = String::new();
    let mut pending_separator = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_separator && !result.is_empty() {
                result.push('-');
            }
            result.push(character.to_ascii_lowercase());
            pending_separator = false;
        } else {
            pending_separator = true;
        }
    }
    if result.is_empty() {
        "pulse-metric-studio".to_string()
    } else {
        result
    }
}

fn log_line(app: &AppHandle, identity: &DesktopIdentity, message: &str) {
    let Ok(directory) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&directory);
    let line = format!(
        "[{}] [{}] {}\n",
        unix_timestamp(),
        identity.identifier,
        message
    );
    let _ = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(format!("{}-desktop.log", identity.log_slug)))
        .and_then(|mut file| file.write_all(line.as_bytes()));
}

fn unix_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "?".into())
}

fn node_major_version(version: &str) -> Option<u32> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn supported_node_runtime(version: &str) -> bool {
    node_major_version(version).is_some_and(|major| major >= 22)
}

fn bundled_node_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let Ok(resources) = app.path().resource_dir() else {
        return Vec::new();
    };
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    vec![
        resources.join("resources").join("runtime").join(executable),
        resources.join("runtime").join(executable),
    ]
}

fn path_node_candidate() -> Option<PathBuf> {
    let lookup = if cfg!(windows) { "where.exe" } else { "which" };
    let output = Command::new(lookup).arg("node").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    (!first.is_empty()).then(|| PathBuf::from(first))
}

fn common_node_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if cfg!(windows) {
        candidates.extend([
            PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
        ]);
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local_app_data).join("Programs/nodejs/node.exe"));
        }
    } else {
        candidates.extend([
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/usr/bin/node"),
            PathBuf::from("/opt/local/bin/node"),
            PathBuf::from("/snap/bin/node"),
        ]);
    }
    candidates
}

fn resolve_node_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = bundled_node_candidates(app);
    if let Some(configured) = std::env::var_os("PULSE_METRIC_STUDIO_NODE_RUNTIME") {
        candidates.push(PathBuf::from(configured));
    }
    if let Some(path_candidate) = path_node_candidate() {
        candidates.push(path_candidate);
    }
    candidates.extend(common_node_candidates());

    let mut checked = HashSet::new();
    let mut old_versions = Vec::new();
    for candidate in candidates {
        if !candidate.exists() || !checked.insert(candidate.clone()) {
            continue;
        }
        let Ok(output) = Command::new(&candidate).arg("--version").output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if supported_node_runtime(&version) {
            return Ok(candidate);
        }
        old_versions.push(format!("{} ({version})", candidate.display()));
    }

    if old_versions.is_empty() {
        Err("Node.js 22 or newer is unavailable. Reinstall the desktop app or set PULSE_METRIC_STUDIO_NODE_RUNTIME.".to_string())
    } else {
        Err(format!(
            "Node.js 22 or newer is required. Unsupported runtimes: {}",
            old_versions.join(", ")
        ))
    }
}

fn main() {
    let app = tauri::Builder::default()
        .manage(ServerHandle(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            tableau_credential_capability,
            tableau_store_credential,
            tableau_replace_credential,
            tableau_delete_credential
        ])
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .setup(|app| {
            let identity = DesktopIdentity::from_app(app.handle());
            let server_listener = reserve_server_listener(DEFAULT_SERVER_PORT).map_err(
                |error| {
                    log_line(app.handle(), &identity, &format!("FATAL: {error}"));
                    error
                },
            )?;
            let port = server_listener
                .local_addr()
                .map_err(|error| format!("Failed to read the reserved server port: {error}"))?
                .port();
            let frontend_origin = format!("http://127.0.0.1:{port}");
            log_line(
                app.handle(),
                &identity,
                &format!("launching {}, port {port}", identity.product_name),
            );

            let entry = resolve_server_entry(app.handle()).ok_or_else(|| {
                log_line(app.handle(), &identity, "FATAL: server bundle not found");
                "Desktop server bundle not found"
            })?;
            log_line(
                app.handle(),
                &identity,
                &format!("server entry: {}", entry.display()),
            );

            let data_directory = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("No app data directory: {error}"))?;
            std::fs::create_dir_all(&data_directory)?;
            log_line(
                app.handle(),
                &identity,
                &format!("data directory: {}", data_directory.display()),
            );

            let node = resolve_node_runtime(app.handle()).map_err(|error| {
                log_line(app.handle(), &identity, &format!("FATAL: {error}"));
                error
            })?;
            log_line(
                app.handle(),
                &identity,
                &format!("node runtime: {}", node.display()),
            );

            let credential_context = CredentialContext::native(&identity.identifier);
            let credential_broker = start_credential_broker(credential_context.clone())?;
            let credential_broker_url = credential_broker.url().to_string();
            let credential_broker_token = credential_broker.token().to_string();
            app.manage(credential_context);
            app.manage(credential_broker);
            log_line(
                app.handle(),
                &identity,
                &format!("credential broker: {credential_broker_url}"),
            );

            let server_log_path = data_directory.join(format!("{}-server.log", identity.log_slug));
            let server_stdout = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&server_log_path)?;
            let server_stderr = server_stdout.try_clone()?;

            let desktop_bootstrap_token = Uuid::new_v4().to_string();

            let mut server_command = Command::new(&node);
            server_command
                .arg(strip_verbatim_prefix(&entry))
                .env("PORT", port.to_string())
                .env("HOST", "127.0.0.1")
                .env("PULSE_METRIC_STUDIO_DATA_DIR", &data_directory)
                .env("PULSE_METRIC_STUDIO_DESKTOP_IDENTIFIER", &identity.identifier)
                .env("PULSE_METRIC_STUDIO_CREDENTIAL_BROKER_URL", &credential_broker_url)
                .env("PULSE_METRIC_STUDIO_CREDENTIAL_BROKER_TOKEN", &credential_broker_token)
                .env("PULSE_METRIC_STUDIO_DESKTOP_BOOTSTRAP_TOKEN", &desktop_bootstrap_token)
                .stdout(Stdio::from(server_stdout))
                .stderr(Stdio::from(server_stderr));

            // Keep the port reserved until every startup input is ready. The
            // authenticated bootstrap check below detects any process that
            // claims the port between this release and the Node bind.
            drop(server_listener);
            let child = server_command
                .spawn()
                .map_err(|error| {
                    log_line(
                        app.handle(),
                        &identity,
                        &format!("FATAL: Node runtime failed to start: {error}"),
                    );
                    format!("Failed to start the desktop server: {error}")
                })?;
            log_line(
                app.handle(),
                &identity,
                &format!("server started with process ID {}", child.id()),
            );
            *app.state::<ServerHandle>().0.lock().unwrap() = Some(child);

            if !wait_for_authenticated_server(
                port,
                &desktop_bootstrap_token,
                Duration::from_secs(25),
            ) {
                log_line(
                    app.handle(),
                    &identity,
                    "FATAL: desktop server failed startup authentication",
                );
                stop_services(app.handle());
                return Err("The desktop server failed startup authentication. Another process might have claimed its local port.".into());
            }
            log_line(app.handle(), &identity, "authenticated startup check passed");

            app.add_capability(
                CapabilityBuilder::new("desktop-bootstrap")
                    .window("main")
                    .local(false)
                    .remote(frontend_origin.clone())
                    .permission("credential-broker")
                    .permission("core:default")
                    .permission("window-state:default"),
            )?;

            build_tray(app.handle(), &identity)?;

            let url: tauri::Url = format!("{frontend_origin}/").parse()?;
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title(&identity.product_name)
                .inner_size(1280.0, 880.0)
                .min_inner_size(960.0, 620.0)
                .visible(false)
                .build()?;
            let state_flags = StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED;
            let _ = window.restore_state(state_flags);
            let _ = window.show();
            let _ = window.set_focus();
            log_line(app.handle(), &identity, "window created");

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Tauri app");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            stop_services(app_handle);
        }
        _ => {}
    });
}

fn kill_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<ServerHandle>() {
        if let Some(mut child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn stop_credential_broker(app: &AppHandle) {
    if let Some(broker) = app.try_state::<CredentialBrokerHandle>() {
        broker.stop();
    }
}

fn stop_services(app: &AppHandle) {
    kill_server(app);
    stop_credential_broker(app);
}

fn strip_verbatim_prefix(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    match value.strip_prefix(r#"\\?\"#) {
        Some(rest) => rest.to_string(),
        None => value,
    }
}

fn resolve_server_entry(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resources) = app.path().resource_dir() {
        for candidate in [
            resources.join("resources/server/dist/index.mjs"),
            resources.join("resources/server/dist/index.cjs"),
            resources.join("server/dist/index.mjs"),
        ] {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    let mut directory = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..6 {
        let candidate = directory.join("packages/server/dist/index.js");
        if candidate.exists() {
            return Some(candidate);
        }
        directory = directory.parent()?.to_path_buf();
    }
    None
}

fn reserve_server_listener(start: u16) -> Result<TcpListener, String> {
    let mut port = start;
    loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => return Ok(listener),
            Err(_) => {
                port = port.checked_add(1).ok_or_else(|| {
                    "No local port is available for the desktop server.".to_string()
                })?;
            }
        }
    }
}

fn http_response(port: u16, path: &str) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(1500)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_millis(1500)))
        .ok()?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    stream.take(64 * 1024).read_to_string(&mut response).ok()?;
    Some(response)
}

#[derive(Debug, Deserialize, PartialEq)]
struct DesktopBootstrap {
    token: String,
}

fn parse_desktop_bootstrap(response: &str) -> Option<DesktopBootstrap> {
    if !(response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")) {
        return None;
    }
    let body = response.split_once("\r\n\r\n")?.1;
    serde_json::from_str(body).ok()
}

fn wait_for_authenticated_server(port: u16, expected_token: &str, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if http_response(port, "/api/desktop/bootstrap")
            .as_deref()
            .and_then(parse_desktop_bootstrap)
            .is_some_and(|bootstrap| bootstrap.token == expected_token)
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &AppHandle, identity: &DesktopIdentity) -> tauri::Result<()> {
    let show_label = format!("Show {}", identity.product_name);
    let quit_label = format!("Quit {}", identity.product_name);
    let show = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let icon = tauri::image::Image::from_bytes(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/icons/tray-32.png"
    )))?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip(&identity.product_name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => {
                stop_services(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
                    {
                        let _ = window.hide();
                    } else {
                        show_main(app);
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_names_become_stable_log_slugs() {
        assert_eq!(slug("Pulse Metric Studio"), "pulse-metric-studio");
        assert_eq!(slug("  Pulse / Metric Studio  "), "pulse-metric-studio");
        assert_eq!(slug(""), "pulse-metric-studio");
    }

    #[test]
    fn node_major_versions_are_parsed() {
        assert_eq!(node_major_version("v20.10.0\n"), Some(20));
        assert_eq!(node_major_version("25.6.1"), Some(25));
        assert_eq!(node_major_version("not-node"), None);
        assert!(!supported_node_runtime("v20.20.2"));
        assert!(!supported_node_runtime("v21.7.3"));
        assert!(supported_node_runtime("v22.23.2"));
        assert!(supported_node_runtime("v25.6.1"));
    }

    #[test]
    fn windows_verbatim_prefix_is_removed() {
        assert_eq!(
            strip_verbatim_prefix(Path::new(r#"\\?\C:\app\server.mjs"#)),
            r"C:\app\server.mjs"
        );
    }

    #[test]
    fn server_uses_an_available_loopback_port() {
        let listener = reserve_server_listener(0).unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        assert_ne!(address.port(), 0);
    }

    #[test]
    fn desktop_bootstrap_requires_the_expected_token() {
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"token\":\"expected-token\"}";
        assert_eq!(
            parse_desktop_bootstrap(response),
            Some(DesktopBootstrap {
                token: "expected-token".to_string(),
            })
        );
        assert_ne!(
            parse_desktop_bootstrap(response).map(|bootstrap| bootstrap.token),
            Some("wrong-token".to_string())
        );
        assert_eq!(
            parse_desktop_bootstrap("HTTP/1.1 503 Unavailable\r\n\r\n{}"),
            None
        );
    }
}
