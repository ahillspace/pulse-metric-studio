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
const DELETE_PATH: &str = "/v1/credentials/delete";
const DATA_KEY_PATH: &str = "/v1/data-key";
const APPROVE_COMMAND_PATH: &str = "/v1/approvals/credential-command";
const DATA_KEY_ACCOUNT: &str = "local-data-key";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_COMMAND_CHARS: usize = 4000;
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_SERVER_URL: usize = 2048;
const MAX_NAME: usize = 256;
const MAX_PAT_SECRET: usize = 4096;
const MAX_CREDENTIAL_REF: usize = 64;

#[derive(Clone, Debug, PartialEq)]
enum StoreError {
    NotFound,
    Unavailable,
}

trait CredentialStore: Send + Sync {
    fn available(&self) -> bool;
    fn get(&self, service: &str, credential_ref: &str) -> Result<String, StoreError>;
    fn set(&self, service: &str, credential_ref: &str, secret: &str) -> Result<(), StoreError>;
    fn delete(&self, service: &str, credential_ref: &str) -> Result<bool, StoreError>;
}

struct NativeCredentialStore;

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn native_entry(service: &str, credential_ref: &str) -> Result<keyring::v1::Entry, StoreError> {
    keyring::v1::Entry::new(service, credential_ref).map_err(|_| StoreError::Unavailable)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn map_native_error(error: keyring::v1::Error) -> StoreError {
    match error {
        keyring::v1::Error::NoEntry => StoreError::NotFound,
        _ => StoreError::Unavailable,
    }
}

impl CredentialStore for NativeCredentialStore {
    fn available(&self) -> bool {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            keyring::v1::Entry::store_status().is_ok()
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            false
        }
    }

    fn get(&self, service: &str, credential_ref: &str) -> Result<String, StoreError> {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            native_entry(service, credential_ref)?
                .get_password()
                .map_err(map_native_error)
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = (service, credential_ref);
            Err(StoreError::Unavailable)
        }
    }

    fn set(&self, service: &str, credential_ref: &str, secret: &str) -> Result<(), StoreError> {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            native_entry(service, credential_ref)?
                .set_password(secret)
                .map_err(map_native_error)
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = (service, credential_ref, secret);
            Err(StoreError::Unavailable)
        }
    }

    fn delete(&self, service: &str, credential_ref: &str) -> Result<bool, StoreError> {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            match native_entry(service, credential_ref)?.delete_credential() {
                Ok(()) => Ok(true),
                Err(keyring::v1::Error::NoEntry) => Ok(false),
                Err(_) => Err(StoreError::Unavailable),
            }
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = (service, credential_ref);
            Err(StoreError::Unavailable)
        }
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
        let mut approved = self.approved.lock().unwrap_or_else(|error| error.into_inner());
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
    tableau_service_name: Arc<str>,
    data_key_service_name: Arc<str>,
    store: Arc<dyn CredentialStore>,
    approvals: Arc<CommandApprovals>,
}

impl CredentialContext {
    pub fn native(app_identifier: &str, data_directory: &std::path::Path) -> Self {
        Self {
            tableau_service_name: Arc::from(format!("{app_identifier}.tableau-pat")),
            data_key_service_name: Arc::from(format!("{app_identifier}.data-key")),
            store: Arc::new(NativeCredentialStore),
            approvals: Arc::new(CommandApprovals::load(
                Some(data_directory.join("approved-credential-commands.json")),
                Arc::new(DialogApprover),
            )),
        }
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
    if server_url.len() > MAX_SERVER_URL
        || site_content_url.len() > MAX_NAME
        || pat_name.len() > MAX_NAME
        || label.is_some_and(|label| label.len() > MAX_NAME)
        || pat_secret.len() > MAX_PAT_SECRET
    {
        return Err("A connection field is too long.".to_string());
    }
    Ok(())
}

fn new_credential_ref() -> String {
    format!("cred_{}", Uuid::new_v4().simple())
}

fn valid_credential_ref(value: &str) -> bool {
    value
        .strip_prefix("cred_")
        .filter(|id| id.len() == 32)
        .is_some_and(|id| Uuid::parse_str(id).is_ok())
}

fn service_for_ref<'a>(context: &'a CredentialContext, credential_ref: &str) -> Option<&'a str> {
    if valid_credential_ref(credential_ref) {
        Some(&context.tableau_service_name)
    } else {
        None
    }
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
    let credential_ref = new_credential_ref();
    context
        .store
        .set(
            &context.tableau_service_name,
            &credential_ref,
            &request.pat_secret,
        )
        .map_err(|_| unavailable_reason().to_string())?;
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
    if old_credential_ref.len() > MAX_CREDENTIAL_REF || !valid_credential_ref(old_credential_ref) {
        return Err("The saved OS credential was not found.".to_string());
    }
    context
        .store
        .get(&context.tableau_service_name, old_credential_ref)
        .map_err(|error| match error {
            StoreError::NotFound => "The saved OS credential was not found.".to_string(),
            StoreError::Unavailable => unavailable_reason().to_string(),
        })?;
    let new_credential_ref = new_credential_ref();
    context
        .store
        .set(
            &context.tableau_service_name,
            &new_credential_ref,
            &request.pat_secret,
        )
        .map_err(|_| unavailable_reason().to_string())?;
    Ok(CredentialReferenceResponse {
        credential_ref: new_credential_ref,
    })
}

#[tauri::command]
pub fn tableau_delete_credential(
    window: WebviewWindow,
    context: State<'_, CredentialContext>,
    request: DeleteCredentialRequest,
) -> Result<DeleteCredentialResponse, String> {
    require_main_window(&window)?;
    let credential_ref = request.credential_ref.trim();
    if credential_ref.len() > MAX_CREDENTIAL_REF || !valid_credential_ref(credential_ref) {
        return Ok(DeleteCredentialResponse { removed: false });
    }
    let removed = context
        .store
        .delete(&context.tableau_service_name, credential_ref)
        .map_err(|_| unavailable_reason().to_string())?;
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
struct DataKeyRequest {
    candidate: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApproveCommandRequest {
    command: String,
}

fn valid_data_key(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
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
    let credential_ref = body.credential_ref.trim();
    let Some(service_name) = service_for_ref(context, credential_ref) else {
        return BrokerResponse::not_found();
    };

    match context.store.get(service_name, credential_ref) {
        Ok(secret) if !secret.trim().is_empty() => {
            BrokerResponse::json(200, "OK", serde_json::json!({ "secret": secret }))
        }
        Ok(_) | Err(StoreError::Unavailable) => BrokerResponse::unavailable(),
        Err(StoreError::NotFound) => BrokerResponse::not_found(),
    }
}

fn delete_response(request: &ParsedRequest, context: &CredentialContext) -> BrokerResponse {
    let Ok(body) = serde_json::from_slice::<DeleteBrokerCredentialRequest>(&request.body) else {
        return BrokerResponse::bad_request();
    };
    let credential_ref = body.credential_ref.trim();
    let Some(service_name) = service_for_ref(context, credential_ref) else {
        return BrokerResponse::not_found();
    };

    match context.store.delete(service_name, credential_ref) {
        Ok(removed) => BrokerResponse::json(200, "OK", serde_json::json!({ "removed": removed })),
        Err(_) => BrokerResponse::unavailable(),
    }
}

/// The local data-encryption key lives in the OS store. The first caller's
/// candidate (a migrated key file or a fresh random key) is kept if none exists.
fn data_key_response(request: &ParsedRequest, context: &CredentialContext) -> BrokerResponse {
    let Ok(body) = serde_json::from_slice::<DataKeyRequest>(&request.body) else {
        return BrokerResponse::bad_request();
    };
    let service = &context.data_key_service_name;
    match context.store.get(service, DATA_KEY_ACCOUNT) {
        Ok(key) if valid_data_key(key.trim()) => {
            return BrokerResponse::json(200, "OK", serde_json::json!({ "key": key.trim() }))
        }
        Ok(_) | Err(StoreError::Unavailable) => return BrokerResponse::unavailable(),
        Err(StoreError::NotFound) => {}
    }
    let candidate = body.candidate.trim().to_ascii_lowercase();
    if !valid_data_key(&candidate) {
        return BrokerResponse::bad_request();
    }
    if context.store.set(service, DATA_KEY_ACCOUNT, &candidate).is_err() {
        return BrokerResponse::unavailable();
    }
    match context.store.get(service, DATA_KEY_ACCOUNT) {
        Ok(key) if valid_data_key(key.trim()) => {
            BrokerResponse::json(200, "OK", serde_json::json!({ "key": key.trim() }))
        }
        _ => BrokerResponse::unavailable(),
    }
}

fn approve_command_response(request: &ParsedRequest, context: &CredentialContext) -> BrokerResponse {
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
        ("DELETE", DELETE_PATH) => delete_response(request, context),
        ("POST", DATA_KEY_PATH) => data_key_response(request, context),
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

    struct TestStore {
        available: bool,
        values: Mutex<HashMap<String, String>>,
        reads: Mutex<usize>,
    }

    struct PanicOnReadStore;

    impl CredentialStore for PanicOnReadStore {
        fn available(&self) -> bool {
            true
        }

        fn get(&self, _service: &str, _credential_ref: &str) -> Result<String, StoreError> {
            panic!("unauthorized requests must not access the credential store")
        }

        fn set(
            &self,
            _service: &str,
            _credential_ref: &str,
            _secret: &str,
        ) -> Result<(), StoreError> {
            unreachable!()
        }

        fn delete(&self, _service: &str, _credential_ref: &str) -> Result<bool, StoreError> {
            unreachable!()
        }
    }

    impl TestStore {
        fn context(available: bool, values: &[(&str, &str)]) -> CredentialContext {
            test_context(
                Arc::new(Self {
                    available,
                    values: Mutex::new(
                        values
                            .iter()
                            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                            .collect(),
                    ),
                    reads: Mutex::new(0),
                }),
                None,
                true,
            )
        }
    }

    impl CredentialStore for TestStore {
        fn available(&self) -> bool {
            self.available
        }

        fn get(&self, _service: &str, credential_ref: &str) -> Result<String, StoreError> {
            *self.reads.lock().unwrap() += 1;
            if !self.available {
                return Err(StoreError::Unavailable);
            }
            self.values
                .lock()
                .unwrap()
                .get(credential_ref)
                .cloned()
                .ok_or(StoreError::NotFound)
        }

        fn set(
            &self,
            _service: &str,
            credential_ref: &str,
            secret: &str,
        ) -> Result<(), StoreError> {
            self.values
                .lock()
                .unwrap()
                .insert(credential_ref.to_string(), secret.to_string());
            Ok(())
        }

        fn delete(&self, _service: &str, credential_ref: &str) -> Result<bool, StoreError> {
            Ok(self.values.lock().unwrap().remove(credential_ref).is_some())
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

    fn test_context(
        store: Arc<dyn CredentialStore>,
        approvals_path: Option<PathBuf>,
        answer: bool,
    ) -> CredentialContext {
        CredentialContext {
            tableau_service_name: Arc::from("com.ahillspace.pulsemetricstudio.tableau-pat"),
            data_key_service_name: Arc::from("com.ahillspace.pulsemetricstudio.data-key"),
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

    fn post(path: &str, body: serde_json::Value) -> ParsedRequest {
        ParsedRequest {
            method: "POST".to_string(),
            path: path.to_string(),
            authorization: Some("Bearer token".to_string()),
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    #[test]
    fn data_key_keeps_the_first_candidate_and_returns_it_afterwards() {
        let context = TestStore::context(true, &[]);
        let first = "a".repeat(64);
        let response = broker_response(&post(DATA_KEY_PATH, serde_json::json!({ "candidate": first })), "token", &context);
        assert_eq!(response.status, 200);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&response.body).unwrap()["key"], first);
        let second = broker_response(
            &post(DATA_KEY_PATH, serde_json::json!({ "candidate": "b".repeat(64) })),
            "token",
            &context,
        );
        assert_eq!(serde_json::from_str::<serde_json::Value>(&second.body).unwrap()["key"], first);
        let invalid = TestStore::context(true, &[]);
        assert_eq!(
            broker_response(&post(DATA_KEY_PATH, serde_json::json!({ "candidate": "short" })), "token", &invalid).status,
            400
        );
        assert_eq!(
            broker_response(&post(DATA_KEY_PATH, serde_json::json!({ "candidate": first })), "token", &TestStore::context(false, &[])).status,
            503
        );
    }

    #[test]
    fn command_approval_asks_once_and_persists_only_hashes() {
        let directory = std::env::temp_dir().join(format!("pms-approvals-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("approved.json");
        let approver = Arc::new(CountingApprover { answer: true, asked: Mutex::new(Vec::new()) });
        let approvals = CommandApprovals::load(Some(path.clone()), approver.clone());
        assert!(approvals.approve("mint-token --secret abc"));
        assert!(approvals.approve("mint-token --secret abc"));
        assert_eq!(approver.asked.lock().unwrap().len(), 1);
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("mint-token"));
        let reloaded_approver = Arc::new(CountingApprover { answer: false, asked: Mutex::new(Vec::new()) });
        let reloaded = CommandApprovals::load(Some(path.clone()), reloaded_approver.clone());
        assert!(reloaded.approve("mint-token --secret abc"));
        assert!(!reloaded.approve("mint-token --secret changed"));
        assert_eq!(reloaded_approver.asked.lock().unwrap().len(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn approval_route_validates_input_and_reports_denial() {
        let context = test_context(Arc::new(PanicOnReadStore), None, false);
        let denied = broker_response(&post(APPROVE_COMMAND_PATH, serde_json::json!({ "command": "mint" })), "token", &context);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&denied.body).unwrap()["approved"], false);
        assert_eq!(
            broker_response(&post(APPROVE_COMMAND_PATH, serde_json::json!({ "command": " " })), "token", &context).status,
            400
        );
        assert_eq!(
            broker_response(&post(APPROVE_COMMAND_PATH, serde_json::json!({ "command": "x".repeat(MAX_COMMAND_CHARS + 1) })), "token", &context).status,
            400
        );
    }

    #[test]
    fn connection_fields_are_bounded() {
        assert!(validate_coordinates("https://tableau.example", "site", "pat", None, "secret").is_ok());
        assert!(validate_coordinates(&"h".repeat(MAX_SERVER_URL + 1), "site", "pat", None, "secret").is_err());
        assert!(validate_coordinates("https://tableau.example", "site", "pat", Some(&"l".repeat(MAX_NAME + 1)), "secret").is_err());
        assert!(validate_coordinates("https://tableau.example", "site", "pat", None, &"s".repeat(MAX_PAT_SECRET + 1)).is_err());
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
            &request(Some("wrong"), &new_credential_ref()),
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
        let mut unsupported_route = request(Some("token"), &new_credential_ref());
        unsupported_route.path = "/v1/credentials/unsupported/store".to_string();
        assert_eq!(
            broker_response(&unsupported_route, "token", &context).status,
            404
        );
    }

    #[test]
    fn broker_statuses_distinguish_found_missing_and_unavailable_credentials() {
        let credential_ref = new_credential_ref();
        let found = TestStore::context(true, &[(credential_ref.as_str(), "test-secret")]);
        let found_response =
            broker_response(&request(Some("token"), &credential_ref), "token", &found);
        assert_eq!(found_response.status, 200);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&found_response.body).unwrap(),
            serde_json::json!({ "secret": "test-secret" })
        );

        let missing = TestStore::context(true, &[]);
        assert_eq!(
            broker_response(&request(Some("token"), &credential_ref), "token", &missing).status,
            404
        );

        let unavailable = TestStore::context(false, &[]);
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
    fn opaque_refs_and_service_names_are_app_specific() {
        let credential_ref = new_credential_ref();
        assert!(valid_credential_ref(&credential_ref));
        assert!(!valid_credential_ref("connection-name"));
        let directory = std::env::temp_dir();
        let context = CredentialContext::native("com.ahillspace.pulsemetricstudio", &directory);
        assert_eq!(
            context.tableau_service_name.as_ref(),
            "com.ahillspace.pulsemetricstudio.tableau-pat"
        );
        assert_eq!(
            context.data_key_service_name.as_ref(),
            "com.ahillspace.pulsemetricstudio.data-key"
        );
        assert_ne!(
            context.tableau_service_name,
            CredentialContext::native("com.example.otherapp", &directory).tableau_service_name
        );
    }
}
