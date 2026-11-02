use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{Manager, State, WebviewWindow};
use uuid::Uuid;

const RESOLVE_PATH: &str = "/v1/credentials/resolve";
const STORE_PATH: &str = "/v1/credentials/store";
const DELETE_PATH: &str = "/v1/credentials/delete";
const LEGACY_DATA_KEY_PATH: &str = "/v1/legacy/data-key";
const APPROVE_COMMAND_PATH: &str = "/v1/approvals/credential-command";
const LEGACY_DATA_KEY_ACCOUNT: &str = "local-data-key";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_COMMAND_CHARS: usize = 4000;
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_SERVER_URL: usize = 2048;
const MAX_NAME: usize = 256;
/// Fits both stores: Credential Manager holds 1,280 UTF-16 characters, and the
/// macOS security tool reads at most a 4 KB command line (the secret goes in as hex).
/// Mirrors SAVED_SECRET_MAX_BYTES in packages/shared.
const MAX_STORED_SECRET: usize = 1200;
const MAX_CREDENTIAL_REF: usize = 64;

#[derive(Clone, Debug, PartialEq)]
enum StoreError {
    NotFound,
    Unavailable,
}

trait CredentialStore: Send + Sync {
    fn available(&self) -> bool;
    fn get(&self, service: &str, account: &str) -> Result<String, StoreError>;
    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), StoreError>;
    fn delete(&self, service: &str, account: &str) -> Result<bool, StoreError>;
}

/// Every item is created and read by Apple's /usr/bin/security tool, so the
/// Keychain's access list trusts that stable system binary instead of this
/// app's build. Updating the app therefore never asks for Keychain access.
#[cfg(target_os = "macos")]
struct SecurityToolStore {
    /// None uses the login keychain; tests use a temporary keychain.
    keychain: Option<PathBuf>,
}

#[cfg(target_os = "macos")]
mod security_tool {
    use super::StoreError;
    use std::io::Write;
    use std::path::Path;
    use std::process::{Command, Output, Stdio};

    const SECURITY_TOOL: &str = "/usr/bin/security";
    const ITEM_NOT_FOUND: i32 = 44;

    fn run(
        arguments: &[&str],
        keychain: Option<&Path>,
        input: Option<&str>,
    ) -> Result<Output, StoreError> {
        let mut command = Command::new(SECURITY_TOOL);
        command.args(arguments);
        if let Some(keychain) = keychain {
            command.arg(keychain);
        }
        let mut child = command
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| StoreError::Unavailable)?;
        if let Some(input) = input {
            let mut stdin = child.stdin.take().ok_or(StoreError::Unavailable)?;
            stdin
                .write_all(input.as_bytes())
                .map_err(|_| StoreError::Unavailable)?;
        }
        child
            .wait_with_output()
            .map_err(|_| StoreError::Unavailable)
    }

    /// Service and account names are app-generated; the interactive command line
    /// quotes them, so they must not contain quoting or whitespace characters.
    fn plain_name(value: &str) -> Result<&str, StoreError> {
        if value.is_empty()
            || value
                .chars()
                .any(|c| c == '"' || c == '\\' || c.is_whitespace() || c.is_control())
        {
            return Err(StoreError::Unavailable);
        }
        Ok(value)
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn unhex(value: &str) -> Option<Vec<u8>> {
        if !value.len().is_multiple_of(2) {
            return None;
        }
        (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(value.get(index..index + 2)?, 16).ok())
            .collect()
    }

    /// `-g` prints `password: "text"` for plain text and `password: 0x<hex>  "..."`
    /// otherwise, so the value reads back exactly whatever bytes it holds.
    pub(super) fn parse_password(diagnostics: &str) -> Option<String> {
        let value = diagnostics
            .lines()
            .find_map(|line| line.strip_prefix("password: "))?;
        if let Some(encoded) = value.strip_prefix("0x") {
            let digits = encoded.split_whitespace().next()?;
            return String::from_utf8(unhex(digits)?).ok();
        }
        value
            .strip_prefix('"')?
            .strip_suffix('"')
            .map(str::to_string)
    }

    pub(super) fn available(keychain: Option<&Path>) -> bool {
        let arguments: &[&str] = if keychain.is_some() {
            &["show-keychain-info"]
        } else {
            &["default-keychain"]
        };
        run(arguments, keychain, None).is_ok_and(|output| output.status.success())
    }

    pub(super) fn get(
        keychain: Option<&Path>,
        service: &str,
        account: &str,
    ) -> Result<String, StoreError> {
        let output = run(
            &[
                "find-generic-password",
                "-s",
                plain_name(service)?,
                "-a",
                plain_name(account)?,
                "-g",
            ],
            keychain,
            None,
        )?;
        match output.status.code() {
            Some(0) => parse_password(&String::from_utf8_lossy(&output.stderr))
                .ok_or(StoreError::Unavailable),
            Some(ITEM_NOT_FOUND) => Err(StoreError::NotFound),
            _ => Err(StoreError::Unavailable),
        }
    }

    /// The secret travels on stdin, never in argv: every local user can read
    /// other processes' arguments on macOS.
    pub(super) fn set(
        keychain: Option<&Path>,
        service: &str,
        account: &str,
        secret: &str,
    ) -> Result<(), StoreError> {
        let target = match keychain {
            None => String::new(),
            Some(path) => format!(
                " \"{}\"",
                plain_name(path.to_str().ok_or(StoreError::Unavailable)?)?
            ),
        };
        let line = format!(
            "add-generic-password -s \"{}\" -a \"{}\" -X {}{target}\n",
            plain_name(service)?,
            plain_name(account)?,
            hex(secret.as_bytes()),
        );
        let output = run(&["-i"], None, Some(&line))?;
        // Interactive mode reports a failed command on stderr, not always through its exit status.
        if output.status.success() && output.stderr.is_empty() {
            Ok(())
        } else {
            Err(StoreError::Unavailable)
        }
    }

    pub(super) fn delete(
        keychain: Option<&Path>,
        service: &str,
        account: &str,
    ) -> Result<bool, StoreError> {
        let output = run(
            &[
                "delete-generic-password",
                "-s",
                plain_name(service)?,
                "-a",
                plain_name(account)?,
            ],
            keychain,
            None,
        )?;
        match output.status.code() {
            Some(0) => Ok(true),
            Some(ITEM_NOT_FOUND) => Ok(false),
            _ => Err(StoreError::Unavailable),
        }
    }
}

#[cfg(target_os = "macos")]
impl CredentialStore for SecurityToolStore {
    fn available(&self) -> bool {
        security_tool::available(self.keychain.as_deref())
    }

    fn get(&self, service: &str, account: &str) -> Result<String, StoreError> {
        security_tool::get(self.keychain.as_deref(), service, account)
    }

    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), StoreError> {
        security_tool::set(self.keychain.as_deref(), service, account, secret)
    }

    fn delete(&self, service: &str, account: &str) -> Result<bool, StoreError> {
        security_tool::delete(self.keychain.as_deref(), service, account)
    }
}

/// Windows Credential Manager, through the keyring crate.
#[cfg(target_os = "windows")]
struct CredentialManagerStore;

#[cfg(target_os = "windows")]
fn credential_manager_entry(
    service: &str,
    account: &str,
) -> Result<keyring::v1::Entry, StoreError> {
    keyring::v1::Entry::new(service, account).map_err(|_| StoreError::Unavailable)
}

#[cfg(target_os = "windows")]
impl CredentialStore for CredentialManagerStore {
    fn available(&self) -> bool {
        keyring::v1::Entry::store_status().is_ok()
    }

    fn get(&self, service: &str, account: &str) -> Result<String, StoreError> {
        credential_manager_entry(service, account)?
            .get_password()
            .map_err(|error| match error {
                keyring::v1::Error::NoEntry => StoreError::NotFound,
                _ => StoreError::Unavailable,
            })
    }

    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), StoreError> {
        credential_manager_entry(service, account)?
            .set_password(secret)
            .map_err(|_| StoreError::Unavailable)
    }

    fn delete(&self, service: &str, account: &str) -> Result<bool, StoreError> {
        match credential_manager_entry(service, account)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::v1::Error::NoEntry) => Ok(false),
            Err(_) => Err(StoreError::Unavailable),
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
struct UnsupportedStore;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl CredentialStore for UnsupportedStore {
    fn available(&self) -> bool {
        false
    }

    fn get(&self, _service: &str, _account: &str) -> Result<String, StoreError> {
        Err(StoreError::Unavailable)
    }

    fn set(&self, _service: &str, _account: &str, _secret: &str) -> Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }

    fn delete(&self, _service: &str, _account: &str) -> Result<bool, StoreError> {
        Err(StoreError::Unavailable)
    }
}

fn native_store() -> Arc<dyn CredentialStore> {
    #[cfg(target_os = "macos")]
    {
        Arc::new(SecurityToolStore { keychain: None })
    }
    #[cfg(target_os = "windows")]
    {
        Arc::new(CredentialManagerStore)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Arc::new(UnsupportedStore)
    }
}

/// Each kind of saved secret has its own OS store service; the reference prefix names the kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CredentialKind {
    TableauPat,
    LlmSecret,
}

impl CredentialKind {
    const ALL: [CredentialKind; 2] = [CredentialKind::TableauPat, CredentialKind::LlmSecret];

    fn prefix(self) -> &'static str {
        match self {
            CredentialKind::TableauPat => "cred_",
            CredentialKind::LlmSecret => "llm_",
        }
    }

    fn of_ref(credential_ref: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| {
            credential_ref
                .strip_prefix(kind.prefix())
                .filter(|id| id.len() == 32)
                .is_some_and(|id| Uuid::parse_str(id).is_ok())
        })
    }

    fn new_ref(self) -> String {
        format!("{}{}", self.prefix(), Uuid::new_v4().simple())
    }
}

/// Asks the person at the keyboard whether a credential command may run.
trait CommandApprover: Send + Sync {
    fn ask(&self, command: &str) -> bool;
}

struct DialogApprover;

impl CommandApprover for DialogApprover {
    fn ask(&self, command: &str) -> bool {
        // Control characters would let a command hide part of itself in the dialog.
        let visible: String = command
            .chars()
            .map(|c| if c.is_control() { '\u{2424}' } else { c })
            .collect();
        let allow = "Allow".to_string();
        let result = rfd::MessageDialog::new()
            .set_title("Allow this credential command?")
            .set_description(format!(
                "Pulse Metric Studio wants to run this command to get an AI provider key:\n\n{visible}\n\nAllow it only if you set it up yourself. Pulse remembers your answer for this exact command."
            ))
            .set_level(rfd::MessageLevel::Warning)
            .set_buttons(rfd::MessageButtons::OkCancelCustom(
                allow.clone(),
                "Don't Allow".to_string(),
            ))
            .show();
        matches!(result, rfd::MessageDialogResult::Custom(ref label) if *label == allow)
    }
}

/// Approved command hashes live in the native layer, which the WebView cannot write.
struct CommandApprovals {
    path: Option<PathBuf>,
    approved: Mutex<HashSet<String>>,
    approver: Arc<dyn CommandApprover>,
}

impl CommandApprovals {
    fn load(path: Option<PathBuf>, approver: Arc<dyn CommandApprover>) -> Self {
        let approved = path
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|hash| hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
            .collect();
        Self {
            path,
            approved: Mutex::new(approved),
            approver,
        }
    }

    fn hash(command: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"pulse-metric-studio.credential-command\0");
        hasher.update(command.as_bytes());
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// Holds the lock while asking, so concurrent requests for one command show one dialog.
    fn approve(&self, command: &str) -> bool {
        let hash = Self::hash(command);
        let mut approved = self
            .approved
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if approved.contains(&hash) {
            return true;
        }
        if !self.approver.ask(command) {
            return false;
        }
        approved.insert(hash);
        if let Some(path) = &self.path {
            let mut hashes: Vec<&String> = approved.iter().collect();
            hashes.sort();
            if let Ok(text) = serde_json::to_string(&hashes) {
                let staged = path.with_extension("json.tmp");
                if std::fs::write(&staged, text).is_ok() {
                    let _ = std::fs::rename(&staged, path);
                }
            }
        }
        true
    }
}

#[derive(Clone)]
pub struct CredentialContext {
    app_identifier: Arc<str>,
    store: Arc<dyn CredentialStore>,
    approvals: Arc<CommandApprovals>,
}

impl CredentialContext {
    pub fn native(app_identifier: &str, data_directory: &std::path::Path) -> Self {
        Self {
            app_identifier: Arc::from(app_identifier),
            store: native_store(),
            approvals: Arc::new(CommandApprovals::load(
                Some(data_directory.join("approved-credential-commands.json")),
                Arc::new(DialogApprover),
            )),
        }
    }

    fn service(&self, kind: CredentialKind) -> String {
        match kind {
            CredentialKind::TableauPat => format!("{}.tableau-pat", self.app_identifier),
            CredentialKind::LlmSecret => format!("{}.llm-secret", self.app_identifier),
        }
    }

    /// Releases before 0.1.2 kept a local data-encryption key in the OS store.
    /// The startup migration reads it once to re-home old secrets, then deletes it.
    fn legacy_data_key_service(&self) -> String {
        format!("{}.data-key", self.app_identifier)
    }

    fn store_secret(&self, kind: CredentialKind, secret: &str) -> Result<String, StoreError> {
        let credential_ref = kind.new_ref();
        self.store
            .set(&self.service(kind), &credential_ref, secret)?;
        Ok(credential_ref)
    }

    fn get_secret(&self, credential_ref: &str) -> Result<String, StoreError> {
        let kind = parse_ref(credential_ref).ok_or(StoreError::NotFound)?;
        self.store.get(&self.service(kind), credential_ref)
    }

    fn delete_secret(&self, credential_ref: &str) -> Result<bool, StoreError> {
        let Some(kind) = parse_ref(credential_ref) else {
            return Ok(false);
        };
        self.store.delete(&self.service(kind), credential_ref)
    }
}

fn parse_ref(credential_ref: &str) -> Option<CredentialKind> {
    if credential_ref.len() > MAX_CREDENTIAL_REF {
        return None;
    }
    CredentialKind::of_ref(credential_ref)
}

fn valid_secret(secret: &str) -> bool {
    !secret.trim().is_empty() && secret.len() <= MAX_STORED_SECRET
}

fn store_error_message(error: StoreError) -> String {
    match error {
        StoreError::NotFound => "The saved OS credential was not found.".to_string(),
        StoreError::Unavailable => unavailable_reason().to_string(),
    }
}

/// Native credential commands serve only the main Pulse window, like pulse_api_request.
fn require_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main"
        || !crate::is_pulse_identifier(&window.app_handle().config().identifier)
    {
        return Err("This window cannot manage credentials.".to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialCapabilityResponse {
    available: bool,
    platform: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreCredentialRequest {
    server_url: String,
    site_content_url: String,
    pat_name: String,
    label: Option<String>,
    pat_secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceCredentialRequest {
    server_url: String,
    site_content_url: String,
    pat_name: String,
    label: Option<String>,
    credential_ref: String,
    pat_secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCredentialRequest {
    credential_ref: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialReferenceResponse {
    credential_ref: String,
}

#[derive(Serialize)]
pub struct DeleteCredentialResponse {
    removed: bool,
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "unsupported"
    }
}

fn unavailable_reason() -> &'static str {
    if cfg!(target_os = "windows") {
        "Windows Credential Manager is unavailable."
    } else if cfg!(target_os = "macos") {
        "macOS Keychain is unavailable."
    } else {
        "OS credential storage is unavailable on this platform."
    }
}

#[tauri::command]
pub fn tableau_credential_capability(
    window: WebviewWindow,
    context: State<'_, CredentialContext>,
) -> Result<CredentialCapabilityResponse, String> {
    require_main_window(&window)?;
    let available = platform_name() != "unsupported" && context.store.available();
    Ok(CredentialCapabilityResponse {
        available,
        platform: platform_name(),
        reason: (!available).then_some(unavailable_reason()),
    })
}

fn validate_coordinates(
    server_url: &str,
    site_content_url: &str,
    pat_name: &str,
    label: Option<&str>,
    pat_secret: &str,
) -> Result<(), String> {
    if server_url.trim().is_empty() || pat_name.trim().is_empty() {
        return Err("Server and PAT name are required.".to_string());
    }
    if pat_secret.trim().is_empty() {
        return Err("The PAT secret is required.".to_string());
    }
    if pat_secret.len() > MAX_STORED_SECRET {
        return Err(format!(
            "The PAT secret is longer than {MAX_STORED_SECRET} bytes."
        ));
    }
    if server_url.len() > MAX_SERVER_URL
        || site_content_url.len() > MAX_NAME
        || pat_name.len() > MAX_NAME
        || label.is_some_and(|label| label.len() > MAX_NAME)
    {
        return Err("A connection field is too long.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn tableau_store_credential(
    window: WebviewWindow,
    context: State<'_, CredentialContext>,
    request: StoreCredentialRequest,
) -> Result<CredentialReferenceResponse, String> {
    require_main_window(&window)?;
    validate_coordinates(
        &request.server_url,
        &request.site_content_url,
        &request.pat_name,
        request.label.as_deref(),
        &request.pat_secret,
    )?;
    let credential_ref = context
        .store_secret(CredentialKind::TableauPat, &request.pat_secret)
        .map_err(store_error_message)?;
    Ok(CredentialReferenceResponse { credential_ref })
}

#[tauri::command]
pub fn tableau_replace_credential(
    window: WebviewWindow,
    context: State<'_, CredentialContext>,
    request: ReplaceCredentialRequest,
) -> Result<CredentialReferenceResponse, String> {
    require_main_window(&window)?;
    validate_coordinates(
        &request.server_url,
        &request.site_content_url,
        &request.pat_name,
        request.label.as_deref(),
        &request.pat_secret,
    )?;
    let old_credential_ref = request.credential_ref.trim();
    if parse_ref(old_credential_ref) != Some(CredentialKind::TableauPat) {
        return Err(store_error_message(StoreError::NotFound));
    }
    context
        .get_secret(old_credential_ref)
        .map_err(store_error_message)?;
    let credential_ref = context
        .store_secret(CredentialKind::TableauPat, &request.pat_secret)
        .map_err(store_error_message)?;
    Ok(CredentialReferenceResponse { credential_ref })
}

#[tauri::command]
pub fn tableau_delete_credential(
    window: WebviewWindow,
    context: State<'_, CredentialContext>,
    request: DeleteCredentialRequest,
) -> Result<DeleteCredentialResponse, String> {
    require_main_window(&window)?;
    let credential_ref = request.credential_ref.trim();
    if parse_ref(credential_ref) != Some(CredentialKind::TableauPat) {
        return Ok(DeleteCredentialResponse { removed: false });
    }
    let removed = context
        .delete_secret(credential_ref)
        .map_err(store_error_message)?;
    Ok(DeleteCredentialResponse { removed })
}

pub struct CredentialBrokerHandle {
    address: SocketAddr,
    url: String,
    token: String,
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl CredentialBrokerHandle {
    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(200));
        if let Some(thread) = self.thread.lock().unwrap().take() {
            let _ = thread.join();
        }
    }
}

impl Drop for CredentialBrokerHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(200));
        if let Ok(thread) = self.thread.get_mut() {
            if let Some(thread) = thread.take() {
                let _ = thread.join();
            }
        }
    }
}

fn new_broker_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub fn start_credential_broker(
    context: CredentialContext,
) -> Result<CredentialBrokerHandle, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| "The OS credential broker could not bind to loopback.".to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "The OS credential broker could not start.".to_string())?;
    let address = listener
        .local_addr()
        .map_err(|_| "The OS credential broker could not determine its address.".to_string())?;
    if !address.ip().is_ipv4() || !address.ip().is_loopback() {
        return Err("The OS credential broker refused a non-loopback address.".to_string());
    }

    let token = new_broker_token();
    let worker_token = token.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let thread = thread::Builder::new()
        .name("tableau-credential-broker".to_string())
        .spawn(move || {
            while !worker_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((_stream, _peer)) if worker_stop.load(Ordering::Acquire) => break,
                    Ok((stream, peer)) if peer.ip().is_loopback() => {
                        // One thread per request: an approval dialog must not
                        // block credential lookups for other requests.
                        let token = worker_token.clone();
                        let context = context.clone();
                        let _ = thread::Builder::new()
                            .name("tableau-credential-request".to_string())
                            .spawn(move || handle_connection(stream, &token, &context));
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|_| "The OS credential broker thread could not start.".to_string())?;

    Ok(CredentialBrokerHandle {
        address,
        url: format!("http://127.0.0.1:{}", address.port()),
        token,
        stop,
        thread: Mutex::new(Some(thread)),
    })
}

#[derive(Debug)]
struct ParsedRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Option<ParsedRequest> {
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok()?;

    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let count = stream.read(&mut buffer).ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > MAX_REQUEST_BYTES {
            return None;
        }
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };

    let headers = std::str::from_utf8(&bytes[..header_end]).ok()?;
    let mut lines = headers.split("\r\n");
    let mut request_line = lines.next()?.split_whitespace();
    let method = request_line.next()?.to_string();
    let path = request_line.next()?.to_string();
    let mut authorization = None;
    let mut content_length = 0_usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("authorization") {
            authorization = Some(value.trim().to_string());
        } else if name.eq_ignore_ascii_case("content-length") {
            content_length = value.trim().parse().ok()?;
        }
    }
    if content_length > MAX_REQUEST_BYTES.saturating_sub(header_end) {
        return None;
    }
    while bytes.len() < header_end + content_length {
        let count = stream.read(&mut buffer).ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > MAX_REQUEST_BYTES {
            return None;
        }
    }

    Some(ParsedRequest {
        method,
        path,
        authorization,
        body: bytes[header_end..header_end + content_length].to_vec(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveRequest {
    credential_ref: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteBrokerCredentialRequest {
    credential_ref: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreBrokerCredentialRequest {
    kind: CredentialKind,
    secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApproveCommandRequest {
    command: String,
}

struct BrokerResponse {
    status: u16,
    reason: &'static str,
    body: String,
}

impl BrokerResponse {
    fn json(status: u16, reason: &'static str, body: serde_json::Value) -> Self {
        Self {
            status,
            reason,
            body: body.to_string(),
        }
    }

    fn unauthorized() -> Self {
        Self::json(
            401,
            "Unauthorized",
            serde_json::json!({ "error": "unauthorized" }),
        )
    }

    fn not_found() -> Self {
        Self::json(
            404,
            "Not Found",
            serde_json::json!({ "error": "not_found" }),
        )
    }

    fn bad_request() -> Self {
        Self::json(
            400,
            "Bad Request",
            serde_json::json!({ "error": "bad_request" }),
        )
    }

    fn unavailable() -> Self {
        Self::json(
            503,
            "Service Unavailable",
            serde_json::json!({ "error": "unavailable" }),
        )
    }
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let max_length = left.len().max(right.len());
    let mut difference = left.len() ^ right.len();
    for index in 0..max_length {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        difference |= usize::from(left_byte ^ right_byte);
    }
    difference == 0
}

fn authorized(header: Option<&str>, token: &str) -> bool {
    let Some(candidate) = header.and_then(|value| value.strip_prefix("Bearer ")) else {
        return false;
    };
    constant_time_equal(candidate.as_bytes(), token.as_bytes())
}

fn resolve_response(request: &ParsedRequest, context: &CredentialContext) -> BrokerResponse {
    let Ok(body) = serde_json::from_slice::<ResolveRequest>(&request.body) else {
        return BrokerResponse::not_found();
    };
    match context.get_secret(body.credential_ref.trim()) {
        Ok(secret) if !secret.trim().is_empty() => {
            BrokerResponse::json(200, "OK", serde_json::json!({ "secret": secret }))
        }
        Ok(_) | Err(StoreError::Unavailable) => BrokerResponse::unavailable(),
        Err(StoreError::NotFound) => BrokerResponse::not_found(),
    }
}

fn store_response(request: &ParsedRequest, context: &CredentialContext) -> BrokerResponse {
    let Ok(body) = serde_json::from_slice::<StoreBrokerCredentialRequest>(&request.body) else {
        return BrokerResponse::bad_request();
    };
    if !valid_secret(&body.secret) {
        return BrokerResponse::bad_request();
    }
    match context.store_secret(body.kind, &body.secret) {
        Ok(credential_ref) => BrokerResponse::json(
            200,
            "OK",
            serde_json::json!({ "credentialRef": credential_ref }),
        ),
        Err(_) => BrokerResponse::unavailable(),
    }
}

fn delete_response(request: &ParsedRequest, context: &CredentialContext) -> BrokerResponse {
    let Ok(body) = serde_json::from_slice::<DeleteBrokerCredentialRequest>(&request.body) else {
        return BrokerResponse::bad_request();
    };
    let credential_ref = body.credential_ref.trim();
    if parse_ref(credential_ref).is_none() {
        return BrokerResponse::not_found();
    }
    match context.delete_secret(credential_ref) {
        Ok(removed) => BrokerResponse::json(200, "OK", serde_json::json!({ "removed": removed })),
        Err(_) => BrokerResponse::unavailable(),
    }
}

fn legacy_data_key_response(context: &CredentialContext) -> BrokerResponse {
    match context
        .store
        .get(&context.legacy_data_key_service(), LEGACY_DATA_KEY_ACCOUNT)
    {
        Ok(key) => BrokerResponse::json(200, "OK", serde_json::json!({ "key": key.trim() })),
        Err(StoreError::NotFound) => BrokerResponse::not_found(),
        Err(StoreError::Unavailable) => BrokerResponse::unavailable(),
    }
}

fn delete_legacy_data_key_response(context: &CredentialContext) -> BrokerResponse {
    match context
        .store
        .delete(&context.legacy_data_key_service(), LEGACY_DATA_KEY_ACCOUNT)
    {
        Ok(removed) => BrokerResponse::json(200, "OK", serde_json::json!({ "removed": removed })),
        Err(_) => BrokerResponse::unavailable(),
    }
}

fn approve_command_response(
    request: &ParsedRequest,
    context: &CredentialContext,
) -> BrokerResponse {
    let Ok(body) = serde_json::from_slice::<ApproveCommandRequest>(&request.body) else {
        return BrokerResponse::bad_request();
    };
    let command = body.command.trim();
    if command.is_empty() || command.chars().count() > MAX_COMMAND_CHARS {
        return BrokerResponse::bad_request();
    }
    let approved = context.approvals.approve(command);
    BrokerResponse::json(200, "OK", serde_json::json!({ "approved": approved }))
}

fn broker_response(
    request: &ParsedRequest,
    token: &str,
    context: &CredentialContext,
) -> BrokerResponse {
    if !authorized(request.authorization.as_deref(), token) {
        return BrokerResponse::unauthorized();
    }

    match (request.method.as_str(), request.path.as_str()) {
        ("POST", RESOLVE_PATH) => resolve_response(request, context),
        ("POST", STORE_PATH) => store_response(request, context),
        ("DELETE", DELETE_PATH) => delete_response(request, context),
        ("POST", LEGACY_DATA_KEY_PATH) => legacy_data_key_response(context),
        ("DELETE", LEGACY_DATA_KEY_PATH) => delete_legacy_data_key_response(context),
        ("POST", APPROVE_COMMAND_PATH) => approve_command_response(request, context),
        _ => BrokerResponse::not_found(),
    }
}

fn write_response(stream: &mut TcpStream, response: BrokerResponse) {
    let headers = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        response.status,
        response.reason,
        response.body.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(response.body.as_bytes());
    let _ = stream.flush();
}

fn handle_connection(mut stream: TcpStream, token: &str, context: &CredentialContext) {
    if let Some(request) = read_request(&mut stream) {
        let response = broker_response(&request, token, context);
        write_response(&mut stream, response);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Keys values by service and account, like the OS stores.
    struct TestStore {
        available: bool,
        values: Mutex<HashMap<(String, String), String>>,
    }

    struct PanicOnReadStore;

    impl CredentialStore for PanicOnReadStore {
        fn available(&self) -> bool {
            true
        }

        fn get(&self, _service: &str, _account: &str) -> Result<String, StoreError> {
            panic!("unauthorized requests must not access the credential store")
        }

        fn set(&self, _service: &str, _account: &str, _secret: &str) -> Result<(), StoreError> {
            unreachable!()
        }

        fn delete(&self, _service: &str, _account: &str) -> Result<bool, StoreError> {
            unreachable!()
        }
    }

    impl TestStore {
        fn context(available: bool) -> (Arc<TestStore>, CredentialContext) {
            let store = Arc::new(Self {
                available,
                values: Mutex::new(HashMap::new()),
            });
            (store.clone(), test_context(store, None, true))
        }

        fn value(&self, service: &str, account: &str) -> Option<String> {
            self.values
                .lock()
                .unwrap()
                .get(&(service.to_string(), account.to_string()))
                .cloned()
        }
    }

    impl CredentialStore for TestStore {
        fn available(&self) -> bool {
            self.available
        }

        fn get(&self, service: &str, account: &str) -> Result<String, StoreError> {
            if !self.available {
                return Err(StoreError::Unavailable);
            }
            self.value(service, account).ok_or(StoreError::NotFound)
        }

        fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), StoreError> {
            if !self.available {
                return Err(StoreError::Unavailable);
            }
            self.values.lock().unwrap().insert(
                (service.to_string(), account.to_string()),
                secret.to_string(),
            );
            Ok(())
        }

        fn delete(&self, service: &str, account: &str) -> Result<bool, StoreError> {
            if !self.available {
                return Err(StoreError::Unavailable);
            }
            Ok(self
                .values
                .lock()
                .unwrap()
                .remove(&(service.to_string(), account.to_string()))
                .is_some())
        }
    }

    struct CountingApprover {
        answer: bool,
        asked: Mutex<Vec<String>>,
    }

    impl CommandApprover for CountingApprover {
        fn ask(&self, command: &str) -> bool {
            self.asked.lock().unwrap().push(command.to_string());
            self.answer
        }
    }

    const APP: &str = "com.ahillspace.pulsemetricstudio";

    fn test_context(
        store: Arc<dyn CredentialStore>,
        approvals_path: Option<PathBuf>,
        answer: bool,
    ) -> CredentialContext {
        CredentialContext {
            app_identifier: Arc::from(APP),
            store,
            approvals: Arc::new(CommandApprovals::load(
                approvals_path,
                Arc::new(CountingApprover {
                    answer,
                    asked: Mutex::new(Vec::new()),
                }),
            )),
        }
    }

    fn call(method: &str, path: &str, body: serde_json::Value) -> ParsedRequest {
        ParsedRequest {
            method: method.to_string(),
            path: path.to_string(),
            authorization: Some("Bearer token".to_string()),
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    fn post(path: &str, body: serde_json::Value) -> ParsedRequest {
        call("POST", path, body)
    }

    fn json(response: &BrokerResponse) -> serde_json::Value {
        serde_json::from_str(&response.body).unwrap()
    }

    #[test]
    fn stored_secrets_resolve_and_delete_under_their_kind_service() {
        let (store, context) = TestStore::context(true);
        let stored = broker_response(
            &post(
                STORE_PATH,
                serde_json::json!({ "kind": "llm-secret", "secret": "sk-test" }),
            ),
            "token",
            &context,
        );
        assert_eq!(stored.status, 200);
        let credential_ref = json(&stored)["credentialRef"].as_str().unwrap().to_string();
        assert!(credential_ref.starts_with("llm_"));
        assert_eq!(
            store
                .value(&format!("{APP}.llm-secret"), &credential_ref)
                .as_deref(),
            Some("sk-test")
        );

        let resolved = broker_response(
            &post(
                RESOLVE_PATH,
                serde_json::json!({ "credentialRef": credential_ref }),
            ),
            "token",
            &context,
        );
        assert_eq!(json(&resolved), serde_json::json!({ "secret": "sk-test" }));

        let delete = call(
            "DELETE",
            DELETE_PATH,
            serde_json::json!({ "credentialRef": credential_ref }),
        );
        assert_eq!(
            json(&broker_response(&delete, "token", &context))["removed"],
            true
        );
        assert_eq!(
            json(&broker_response(&delete, "token", &context))["removed"],
            false
        );
        assert_eq!(
            broker_response(
                &post(
                    RESOLVE_PATH,
                    serde_json::json!({ "credentialRef": credential_ref })
                ),
                "token",
                &context
            )
            .status,
            404
        );
    }

    #[test]
    fn store_route_rejects_empty_oversized_and_unknown_secrets() {
        let (_store, context) = TestStore::context(true);
        let store = |body: serde_json::Value| {
            broker_response(&post(STORE_PATH, body), "token", &context).status
        };
        assert_eq!(
            store(serde_json::json!({ "kind": "llm-secret", "secret": " " })),
            400
        );
        assert_eq!(
            store(
                serde_json::json!({ "kind": "llm-secret", "secret": "s".repeat(MAX_STORED_SECRET + 1) })
            ),
            400
        );
        assert_eq!(
            store(
                serde_json::json!({ "kind": "llm-secret", "secret": "s".repeat(MAX_STORED_SECRET) })
            ),
            200
        );
        assert_eq!(
            store(serde_json::json!({ "kind": "data-key", "secret": "s" })),
            400
        );
        let (_store, unavailable) = TestStore::context(false);
        assert_eq!(
            broker_response(
                &post(
                    STORE_PATH,
                    serde_json::json!({ "kind": "tableau-pat", "secret": "s" })
                ),
                "token",
                &unavailable
            )
            .status,
            503
        );
    }

    #[test]
    fn legacy_data_key_is_read_until_deleted() {
        let (store, context) = TestStore::context(true);
        let read = || {
            broker_response(
                &post(LEGACY_DATA_KEY_PATH, serde_json::json!({})),
                "token",
                &context,
            )
        };
        assert_eq!(read().status, 404);
        store
            .set(
                &format!("{APP}.data-key"),
                LEGACY_DATA_KEY_ACCOUNT,
                "ab".repeat(32).as_str(),
            )
            .unwrap();
        assert_eq!(json(&read())["key"], "ab".repeat(32));
        let delete = call("DELETE", LEGACY_DATA_KEY_PATH, serde_json::json!({}));
        assert_eq!(
            json(&broker_response(&delete, "token", &context))["removed"],
            true
        );
        assert_eq!(read().status, 404);
        let (_store, unavailable) = TestStore::context(false);
        assert_eq!(
            broker_response(
                &post(LEGACY_DATA_KEY_PATH, serde_json::json!({})),
                "token",
                &unavailable
            )
            .status,
            503
        );
    }

    #[test]
    fn command_approval_asks_once_and_persists_only_hashes() {
        let directory =
            std::env::temp_dir().join(format!("pms-approvals-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("approved.json");
        let approver = Arc::new(CountingApprover {
            answer: true,
            asked: Mutex::new(Vec::new()),
        });
        let approvals = CommandApprovals::load(Some(path.clone()), approver.clone());
        assert!(approvals.approve("mint-token --secret abc"));
        assert!(approvals.approve("mint-token --secret abc"));
        assert_eq!(approver.asked.lock().unwrap().len(), 1);
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("mint-token"));
        let reloaded_approver = Arc::new(CountingApprover {
            answer: false,
            asked: Mutex::new(Vec::new()),
        });
        let reloaded = CommandApprovals::load(Some(path.clone()), reloaded_approver.clone());
        assert!(reloaded.approve("mint-token --secret abc"));
        assert!(!reloaded.approve("mint-token --secret changed"));
        assert_eq!(reloaded_approver.asked.lock().unwrap().len(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn approval_route_validates_input_and_reports_denial() {
        let context = test_context(Arc::new(PanicOnReadStore), None, false);
        let denied = broker_response(
            &post(
                APPROVE_COMMAND_PATH,
                serde_json::json!({ "command": "mint" }),
            ),
            "token",
            &context,
        );
        assert_eq!(json(&denied)["approved"], false);
        assert_eq!(
            broker_response(
                &post(APPROVE_COMMAND_PATH, serde_json::json!({ "command": " " })),
                "token",
                &context
            )
            .status,
            400
        );
        assert_eq!(
            broker_response(
                &post(
                    APPROVE_COMMAND_PATH,
                    serde_json::json!({ "command": "x".repeat(MAX_COMMAND_CHARS + 1) })
                ),
                "token",
                &context
            )
            .status,
            400
        );
    }

    #[test]
    fn connection_fields_are_bounded() {
        assert!(
            validate_coordinates("https://tableau.example", "site", "pat", None, "secret").is_ok()
        );
        assert!(validate_coordinates(
            &"h".repeat(MAX_SERVER_URL + 1),
            "site",
            "pat",
            None,
            "secret"
        )
        .is_err());
        assert!(validate_coordinates(
            "https://tableau.example",
            "site",
            "pat",
            Some(&"l".repeat(MAX_NAME + 1)),
            "secret"
        )
        .is_err());
        assert!(validate_coordinates(
            "https://tableau.example",
            "site",
            "pat",
            None,
            &"s".repeat(MAX_STORED_SECRET)
        )
        .is_ok());
        assert!(validate_coordinates(
            "https://tableau.example",
            "site",
            "pat",
            None,
            &"s".repeat(MAX_STORED_SECRET + 1)
        )
        .is_err());
    }

    fn request(token: Option<&str>, credential_ref: &str) -> ParsedRequest {
        ParsedRequest {
            method: "POST".to_string(),
            path: RESOLVE_PATH.to_string(),
            authorization: token.map(|value| format!("Bearer {value}")),
            body: serde_json::to_vec(&serde_json::json!({
                "credentialRef": credential_ref,
            }))
            .unwrap(),
        }
    }

    #[test]
    fn broker_token_comparison_rejects_missing_partial_and_extra_tokens() {
        assert!(authorized(Some("Bearer private-token"), "private-token"));
        assert!(!authorized(None, "private-token"));
        assert!(!authorized(Some("Bearer private"), "private-token"));
        assert!(!authorized(
            Some("Bearer private-token-extra"),
            "private-token"
        ));
    }

    #[test]
    fn unauthorized_requests_return_401_before_store_access() {
        let context = test_context(Arc::new(PanicOnReadStore), None, true);
        let response = broker_response(
            &request(Some("wrong"), &CredentialKind::TableauPat.new_ref()),
            "token",
            &context,
        );
        assert_eq!(response.status, 401);
    }

    #[test]
    fn unsupported_routes_and_reference_types_do_not_access_credentials() {
        let context = test_context(Arc::new(PanicOnReadStore), None, true);
        let invalid_reference = request(Some("token"), "unsupported_reference");
        assert_eq!(
            broker_response(&invalid_reference, "token", &context).status,
            404
        );
        let mut unsupported_route = request(Some("token"), &CredentialKind::TableauPat.new_ref());
        unsupported_route.path = "/v1/credentials/unsupported/store".to_string();
        assert_eq!(
            broker_response(&unsupported_route, "token", &context).status,
            404
        );
    }

    #[test]
    fn broker_statuses_distinguish_found_missing_and_unavailable_credentials() {
        let (_store, found) = TestStore::context(true);
        let credential_ref = found
            .store_secret(CredentialKind::TableauPat, "test-secret")
            .unwrap();
        let found_response =
            broker_response(&request(Some("token"), &credential_ref), "token", &found);
        assert_eq!(found_response.status, 200);
        assert_eq!(
            json(&found_response),
            serde_json::json!({ "secret": "test-secret" })
        );

        let (_store, missing) = TestStore::context(true);
        assert_eq!(
            broker_response(&request(Some("token"), &credential_ref), "token", &missing).status,
            404
        );

        let (_store, unavailable) = TestStore::context(false);
        assert_eq!(
            broker_response(
                &request(Some("token"), &credential_ref),
                "token",
                &unavailable,
            )
            .status,
            503
        );
    }

    #[test]
    fn opaque_refs_name_their_kind_and_services_are_app_specific() {
        let tableau = CredentialKind::TableauPat.new_ref();
        let llm = CredentialKind::LlmSecret.new_ref();
        assert_eq!(parse_ref(&tableau), Some(CredentialKind::TableauPat));
        assert_eq!(parse_ref(&llm), Some(CredentialKind::LlmSecret));
        assert_eq!(parse_ref("connection-name"), None);
        assert_eq!(parse_ref(&format!("llm_{}", "g".repeat(32))), None);
        let directory = std::env::temp_dir();
        let context = CredentialContext::native(APP, &directory);
        assert_eq!(
            context.service(CredentialKind::TableauPat),
            format!("{APP}.tableau-pat")
        );
        assert_eq!(
            context.service(CredentialKind::LlmSecret),
            format!("{APP}.llm-secret")
        );
        assert_eq!(context.legacy_data_key_service(), format!("{APP}.data-key"));
        assert_ne!(
            context.service(CredentialKind::TableauPat),
            CredentialContext::native("com.example.otherapp", &directory)
                .service(CredentialKind::TableauPat)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn security_tool_reads_back_exactly_what_it_saved() {
        assert_eq!(
            security_tool::parse_password("keychain: \"x\"\npassword: \"plain\"\n").as_deref(),
            Some("plain")
        );
        assert_eq!(
            security_tool::parse_password("password: 0x6869E280A2  \"hi\\342\\200\\242\"\n")
                .as_deref(),
            Some("hi\u{2022}")
        );
        assert_eq!(security_tool::parse_password("password: \n"), None);
        assert_eq!(security_tool::parse_password("nothing here"), None);
    }

    /// Runs the real security tool against a throwaway keychain, never the login keychain.
    #[cfg(target_os = "macos")]
    #[test]
    fn security_tool_store_round_trips_against_a_temporary_keychain() {
        let path =
            std::env::temp_dir().join(format!("pms-{}.keychain-db", Uuid::new_v4().simple()));
        let keychain = path.to_str().unwrap();
        let created = std::process::Command::new("/usr/bin/security")
            .args(["create-keychain", "-p", "pms-test", keychain])
            .status()
            .unwrap();
        assert!(created.success());
        let store = SecurityToolStore {
            keychain: Some(path.clone()),
        };
        let outcome = std::panic::catch_unwind(|| {
            assert!(store.available());
            let service = format!("{APP}.llm-secret");
            for secret in [
                "sk-plain",
                "quote\"back\\slash $HOME 'single'",
                "line\nbreak\ttab",
                "caf\u{e9} \u{1f511}",
                &"x".repeat(MAX_STORED_SECRET),
            ] {
                let account = CredentialKind::LlmSecret.new_ref();
                store.set(&service, &account, secret).unwrap();
                assert_eq!(store.get(&service, &account).unwrap(), secret);
                assert!(store.delete(&service, &account).unwrap());
                assert_eq!(store.get(&service, &account), Err(StoreError::NotFound));
                assert!(!store.delete(&service, &account).unwrap());
            }
            assert_eq!(
                store.set("bad service", "account", "secret"),
                Err(StoreError::Unavailable)
            );
        });
        let _ = std::process::Command::new("/usr/bin/security")
            .args(["delete-keychain", keychain])
            .status();
        let _ = std::fs::remove_file(&path);
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
    }
}
