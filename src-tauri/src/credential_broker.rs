use serde::{Deserialize, Serialize};
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::State;
use uuid::Uuid;

const RESOLVE_PATH: &str = "/v1/credentials/resolve";
const DELETE_PATH: &str = "/v1/credentials/delete";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(2);

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

#[derive(Clone)]
pub struct CredentialContext {
    tableau_service_name: Arc<str>,
    store: Arc<dyn CredentialStore>,
}

impl CredentialContext {
    pub fn native(app_identifier: &str) -> Self {
        Self {
            tableau_service_name: Arc::from(format!("{app_identifier}.tableau-pat")),
            store: Arc::new(NativeCredentialStore),
        }
    }
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
    context: State<'_, CredentialContext>,
) -> CredentialCapabilityResponse {
    let available = platform_name() != "unsupported" && context.store.available();
    CredentialCapabilityResponse {
        available,
        platform: platform_name(),
        reason: (!available).then_some(unavailable_reason()),
    }
}

fn validate_coordinates(
    server_url: &str,
    site_content_url: &str,
    pat_name: &str,
    label: Option<&str>,
    pat_secret: &str,
) -> Result<(), String> {
    let _ = (site_content_url, label);
    if server_url.trim().is_empty() || pat_name.trim().is_empty() {
        return Err("Server and PAT name are required.".to_string());
    }
    if pat_secret.trim().is_empty() {
        return Err("The PAT secret is required.".to_string());
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
    context: State<'_, CredentialContext>,
    request: StoreCredentialRequest,
) -> Result<CredentialReferenceResponse, String> {
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
    context: State<'_, CredentialContext>,
    request: ReplaceCredentialRequest,
) -> Result<CredentialReferenceResponse, String> {
    validate_coordinates(
        &request.server_url,
        &request.site_content_url,
        &request.pat_name,
        request.label.as_deref(),
        &request.pat_secret,
    )?;
    let old_credential_ref = request.credential_ref.trim();
    if !valid_credential_ref(old_credential_ref) {
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
    context: State<'_, CredentialContext>,
    request: DeleteCredentialRequest,
) -> Result<DeleteCredentialResponse, String> {
    let credential_ref = request.credential_ref.trim();
    if !valid_credential_ref(credential_ref) {
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
                        handle_connection(stream, &worker_token, &context);
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
            CredentialContext {
                tableau_service_name: Arc::from("com.ahillspace.pulsemetricstudio.tableau-pat"),
                store: Arc::new(Self {
                    available,
                    values: Mutex::new(
                        values
                            .iter()
                            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                            .collect(),
                    ),
                    reads: Mutex::new(0),
                }),
            }
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
        let context = CredentialContext {
            tableau_service_name: Arc::from("com.ahillspace.pulsemetricstudio.tableau-pat"),
            store: Arc::new(PanicOnReadStore),
        };
        let response = broker_response(
            &request(Some("wrong"), &new_credential_ref()),
            "token",
            &context,
        );
        assert_eq!(response.status, 401);
    }

    #[test]
    fn unsupported_routes_and_reference_types_do_not_access_credentials() {
        let context = CredentialContext {
            tableau_service_name: Arc::from("com.ahillspace.pulsemetricstudio.tableau-pat"),
            store: Arc::new(PanicOnReadStore),
        };
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
        assert_eq!(
            CredentialContext::native("com.ahillspace.pulsemetricstudio")
                .tableau_service_name
                .as_ref(),
            "com.ahillspace.pulsemetricstudio.tableau-pat"
        );
        assert_ne!(
            CredentialContext::native("com.ahillspace.pulsemetricstudio").tableau_service_name,
            CredentialContext::native("com.example.otherapp").tableau_service_name
        );
    }
}
