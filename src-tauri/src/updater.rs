//! In-app updates.
//!
//! The one-line installer records the release repository it installed from
//! (the update channel) in the app data folder. This module checks that
//! repository for a newer release and, when the person agrees, closes the app
//! and runs the bundled installer against it. The installer owns how a
//! repository is reached (plain HTTPS for public ones, the GitHub CLI for
//! private ones), so internal and public releases never mix. A copy that no
//! installer recorded (a disk image or setup file opened by hand) has no
//! channel and never updates itself.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

const CHANNEL_FILE: &str = "update-channel";
/// The installer writes why an update it ran for the app did not finish.
const ERROR_FILE: &str = "update-error";
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(90);
pub const STATUS_EVENT: &str = "pulse-update-status";

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    /// A newer release in the update channel, once a check has found one.
    available_version: Option<String>,
    /// Why the previous update attempt did not finish.
    last_error: Option<String>,
}

pub struct Updater {
    channel: Option<Channel>,
    status: Mutex<UpdateStatus>,
    /// Set while the app closes to install an update.
    pending: AtomicBool,
}

struct Channel {
    repository: String,
    installer: PathBuf,
    data_dir: PathBuf,
    log_path: PathBuf,
}

#[derive(Clone, Copy)]
enum InstallerAction {
    LatestVersion,
    Update,
}

impl Updater {
    pub fn new(app: &AppHandle, data_dir: &Path, log_slug: &str) -> Self {
        let last_error = std::fs::read_to_string(data_dir.join(ERROR_FILE))
            .ok()
            .map(|message| message.trim().to_string())
            .filter(|message| !message.is_empty());
        let _ = std::fs::remove_file(data_dir.join(ERROR_FILE));
        // Development builds run from the source tree, which no installer manages.
        let channel = if cfg!(debug_assertions) {
            None
        } else {
            read_channel(data_dir)
                .zip(bundled_installer(app))
                .map(|(repository, installer)| Channel {
                    repository,
                    installer,
                    data_dir: data_dir.to_path_buf(),
                    log_path: data_dir.join(format!("{log_slug}-update.log")),
                })
        };
        Self {
            channel,
            status: Mutex::new(UpdateStatus {
                current_version: app.package_info().version.to_string(),
                available_version: None,
                last_error,
            }),
            pending: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> UpdateStatus {
        self.status.lock().unwrap().clone()
    }

    /// Checks at launch and then once a day, telling the main window whenever the answer changes.
    pub fn start(app: AppHandle, log: impl Fn(&str) + Send + 'static) {
        let Some(channel) = app
            .state::<Updater>()
            .channel
            .as_ref()
            .map(|channel| channel.repository.clone())
        else {
            log("updates: no update channel; this copy was not installed by the installer");
            return;
        };
        log(&format!("updates: checking {channel}"));
        std::thread::spawn(move || loop {
            let updater = app.state::<Updater>();
            match updater.latest_version() {
                Ok(latest) => {
                    let changed = {
                        let mut status = updater.status.lock().unwrap();
                        let available = newer(&latest, &status.current_version).then_some(latest);
                        let changed = status.available_version != available;
                        status.available_version = available;
                        changed
                    };
                    if changed {
                        let _ = app.emit_to("main", STATUS_EVENT, updater.status());
                    }
                }
                Err(error) => log(&format!("updates: check failed: {error}")),
            }
            std::thread::sleep(CHECK_INTERVAL);
        });
    }

    fn latest_version(&self) -> Result<String, String> {
        let channel = self
            .channel
            .as_ref()
            .ok_or("No update channel is recorded.")?;
        let child = installer_command(channel, InstallerAction::LatestVersion)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("the installer could not start: {error}"))?;
        let (success, stdout, stderr) = wait_with_timeout(child, CHECK_TIMEOUT)?;
        if !success {
            return Err(stderr.trim().to_string());
        }
        let version = stdout.trim();
        parse_version(version)
            .map(|_| version.to_string())
            .ok_or_else(|| format!("the installer reported an unrecognized version: {version}"))
    }

    /// Closes the app through the normal close flow; the update starts once it has closed.
    pub fn request(&self, app: &AppHandle) -> Result<(), String> {
        if self.channel.is_none() || self.status().available_version.is_none() {
            return Err("No update is available.".into());
        }
        self.pending.store(true, Ordering::Release);
        app.exit(0);
        Ok(())
    }

    /// A cancelled close also cancels the update waiting on it.
    pub fn cancel(&self) {
        self.pending.store(false, Ordering::Release);
    }

    /// Runs the installer once the app has stopped its services and is exiting.
    pub fn launch_pending(&self) -> Result<(), String> {
        let Some(channel) = self.channel.as_ref() else {
            return Ok(());
        };
        if !self.pending.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        let result = std::fs::File::create(&channel.log_path)
            .and_then(|log| Ok((log.try_clone()?, log)))
            .and_then(|(stdout, stderr)| {
                let mut command = installer_command(channel, InstallerAction::Update);
                command.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    // Outlive the app, which exits right after this.
                    command.process_group(0);
                }
                command.spawn()
            });
        result.map(|_| ()).map_err(|error| {
            let message = format!("The installer could not start: {error}");
            let _ = std::fs::write(channel.data_dir.join(ERROR_FILE), &message);
            message
        })
    }
}

fn read_channel(data_dir: &Path) -> Option<String> {
    let repository = std::fs::read_to_string(data_dir.join(CHANNEL_FILE))
        .ok()?
        .trim()
        .to_string();
    valid_repository(&repository).then_some(repository)
}

fn valid_repository(repository: &str) -> bool {
    let mut parts = repository.split('/');
    let valid_part = |part: Option<&str>| {
        part.is_some_and(|part| {
            !part.is_empty()
                && !part.starts_with(['.', '-'])
                && part
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
        })
    };
    valid_part(parts.next()) && valid_part(parts.next()) && parts.next().is_none()
}

fn bundled_installer(app: &AppHandle) -> Option<PathBuf> {
    let resources = app.path().resource_dir().ok()?;
    let script = if cfg!(windows) {
        "install.ps1"
    } else {
        "install.sh"
    };
    [
        resources.join("resources").join("installer").join(script),
        resources.join("installer").join(script),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

#[cfg(not(windows))]
fn installer_command(channel: &Channel, action: InstallerAction) -> Command {
    let mut command = Command::new("/bin/sh");
    command.arg(&channel.installer);
    match action {
        InstallerAction::LatestVersion => {
            command.arg("latest-version");
        }
        InstallerAction::Update => {
            command.args(["install", "--update"]);
            // Reinstall where this copy lives: .../Pulse Metric Studio.app/Contents/MacOS/<binary>.
            if let Some(install_dir) = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.ancestors().nth(4).map(Path::to_path_buf))
            {
                command.arg("--install-dir").arg(install_dir);
            }
        }
    }
    command.arg("--repo").arg(&channel.repository);
    command
}

#[cfg(windows)]
fn installer_command(channel: &Channel, action: InstallerAction) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&channel.installer)
        .args(match action {
            InstallerAction::LatestVersion => &["-Action", "LatestVersion"][..],
            InstallerAction::Update => &["-Action", "Install", "-Update"][..],
        })
        .arg("-Repo")
        .arg(&channel.repository)
        .creation_flags(CREATE_NO_WINDOW);
    command
}

fn wait_with_timeout(
    mut child: Child,
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    // Drain both pipes while waiting so a chatty installer cannot fill one and stall.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        })
    };
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("the release check timed out".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    Ok((status.success(), stdout, stderr))
}

fn parse_version(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.trim().trim_start_matches('v').split('.');
    let mut next = || parts.next()?.parse().ok();
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

fn newer(candidate: &str, current: &str) -> bool {
    matches!((parse_version(candidate), parse_version(current)), (Some(candidate), Some(current)) if candidate > current)
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    (window.label() == "main")
        .then_some(())
        .ok_or_else(|| "This window cannot manage updates.".to_string())
}

#[tauri::command]
pub fn pulse_update_status(
    window: tauri::WebviewWindow,
    updater: tauri::State<'_, Updater>,
) -> Result<UpdateStatus, String> {
    main_window(&window)?;
    Ok(updater.status())
}

#[tauri::command]
pub fn pulse_update_apply(
    window: tauri::WebviewWindow,
    updater: tauri::State<'_, Updater>,
) -> Result<(), String> {
    main_window(&window)?;
    updater.request(window.app_handle())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(newer("0.1.10", "0.1.9"));
        assert!(newer("1.0.0", "0.9.9"));
        assert!(!newer("0.1.2", "0.1.2"));
        assert!(!newer("0.1.1", "0.1.2"));
        assert!(!newer("0.1", "0.0.1"));
        assert!(!newer("0.1.2-beta", "0.1.1"));
        assert_eq!(parse_version("v0.1.2\n"), Some((0, 1, 2)));
        assert_eq!(parse_version("0.1.2.3"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_long_installer_output_does_not_stall_the_check() {
        let child = Command::new("/bin/sh")
            .args([
                "-c",
                "head -c 200000 /dev/zero | tr '\\0' x >&2; echo 0.1.2",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let (success, stdout, stderr) = wait_with_timeout(child, Duration::from_secs(10)).unwrap();
        assert!(success);
        assert_eq!(stdout.trim(), "0.1.2");
        assert_eq!(stderr.len(), 200_000);
    }

    #[test]
    fn channels_must_be_a_github_repository() {
        assert!(valid_repository("ahillspace/pulse-metric-studio"));
        assert!(valid_repository("sfdc-qbranch-emu/pulse-metric-studio"));
        assert!(!valid_repository("pulse-metric-studio"));
        assert!(!valid_repository("a/b/c"));
        assert!(!valid_repository("../b"));
        assert!(!valid_repository("a/b --version 1"));
        assert!(!valid_repository("a/"));
    }

    #[test]
    fn the_recorded_channel_is_read_and_validated() {
        let directory = std::env::temp_dir().join(format!(
            "pulse-update-channel-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        assert_eq!(read_channel(&directory), None);
        std::fs::write(
            directory.join(CHANNEL_FILE),
            "ahillspace/pulse-metric-studio\r\n",
        )
        .unwrap();
        assert_eq!(
            read_channel(&directory).as_deref(),
            Some("ahillspace/pulse-metric-studio")
        );
        std::fs::write(directory.join(CHANNEL_FILE), "--repo/x").unwrap();
        assert_eq!(read_channel(&directory), None);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
