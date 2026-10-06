use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::io::Read;
use std::time::Duration;
use tauri::{Manager, State, WebviewWindow};

const MAX_BODY: usize = 16 * 1024 * 1024;
const MAX_RESPONSE: u64 = 16 * 1024 * 1024;
pub const PROTOCOL: u32 = 1;

#[derive(Clone)]
pub struct PulseTransport {
    pub port: u16,
    pub token: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApiRequest {
    method: String,
    path: String,
    body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    status: u16,
    body: String,
    content_type: String,
}

/// Assistant requests wait longer than the server's 5-minute deadline so its
/// explanation arrives first. Writes (publishing, variants, deletion) keep five
/// minutes so a long batch is never cut off with an unknown outcome. Reads
/// fail within two minutes.
fn request_timeout(method: &str, path: &str) -> Duration {
    let route = path.split('?').next().unwrap_or("");
    let assistant = route == "/api/llm/author"
        || route.ends_with("/proposals")
        || (route.starts_with("/api/llm/profiles/") && route.ends_with("/test"));
    if assistant {
        Duration::from_secs(330)
    } else if method == "GET" {
        Duration::from_secs(120)
    } else {
        Duration::from_secs(300)
    }
}

fn validate_request(request: &ApiRequest) -> Result<(), String> {
    if !matches!(request.method.as_str(), "GET" | "POST" | "PUT" | "DELETE") {
        return Err("Unsupported desktop request method.".into());
    }
    if request.path.len() > 16 * 1024
        || request
            .path
            .chars()
            .any(|c| c.is_control() || c == '\\' || c == '#')
    {
        return Err("Invalid desktop request path.".into());
    }
    let path = request.path.split('?').next().unwrap_or("");
    // Encoded route separators and dot segments must never change routing after validation.
    let lower = path.to_ascii_lowercase();
    if lower.contains("%2f")
        || lower.contains("%5c")
        || lower.contains("%2e")
        || lower.contains("%25")
        || path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
    {
        return Err("Invalid desktop request path.".into());
    }
    let allowed = ["/api/pulse", "/api/tableau", "/api/datasources", "/api/llm"]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")));
    if !allowed {
        return Err("Desktop request path is not allowed.".into());
    }
    if let Some(body) = &request.body {
        if request.method == "GET"
            || body.len() > MAX_BODY
            || serde_json::from_str::<serde_json::Value>(body).is_err()
        {
            return Err("Desktop request body must be bounded JSON.".into());
        }
    }
    Ok(())
}

impl PulseTransport {
    fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
        timeout: Duration,
    ) -> Result<ApiResponse, String> {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(timeout)
            .build()
            .map_err(|_| "The desktop transport could not start.".to_string())?;
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| "Invalid request method.".to_string())?;
        let url = reqwest::Url::parse(&format!("http://127.0.0.1:{}{path}", self.port))
            .map_err(|_| "Invalid desktop request path.".to_string())?;
        // Each request carries a one-time signature instead of the launch token,
        // so a process that takes over the port after the readiness proof
        // learns nothing it can reuse.
        let target = match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_string(),
        };
        let nonce = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "The system clock is invalid.".to_string())?
            .as_millis()
            .to_string();
        let signature = readiness_proof(
            &self.token,
            &request_message(method.as_str(), &target, &nonce, &timestamp),
        );
        let mut request = client
            .request(method, url)
            .header("X-Pulse-Nonce", nonce)
            .header("X-Pulse-Timestamp", timestamp)
            .header("X-Pulse-Signature", signature)
            .header("Accept", "application/json");
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(body);
        }
        let response = request.send().map_err(|_| "The desktop service is unavailable or interrupted. Restart Pulse Metric Studio and inspect Activity before repeating a change.".to_string())?;
        let status = response.status().as_u16();
        if response.status().is_redirection() {
            return Err("Desktop redirects are not allowed.".into());
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE)
        {
            return Err("The desktop response is too large.".into());
        }
        let content_type = response
            .headers()
            .get("Content-Type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/json")
            .to_string();
        let mut body = Vec::new();
        response
            .take(MAX_RESPONSE + 1)
            .read_to_end(&mut body)
            .map_err(|_| "Desktop response was interrupted.".to_string())?;
        if body.len() as u64 > MAX_RESPONSE {
            return Err("The desktop response is too large.".into());
        }
        let body = String::from_utf8(body)
            .map_err(|_| "Invalid desktop response encoding.".to_string())?;
        Ok(ApiResponse {
            status,
            body,
            content_type,
        })
    }

    pub fn ready(&self) -> bool {
        let challenge = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let proof = readiness_proof(&self.token, &format!("ready-request:{challenge}"));
        let Ok(client) = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
        else {
            return false;
        };
        let Ok(response) = client
            .get(format!(
                "http://127.0.0.1:{}/api/desktop/ready?challenge={challenge}",
                self.port
            ))
            .header("x-pulse-proof", proof)
            .send()
        else {
            return false;
        };
        if response.status() != 200 {
            return false;
        }
        let mut body = String::new();
        if response.take(4096).read_to_string(&mut body).is_err() {
            return false;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) else {
            return false;
        };
        value["ready"] == true
            && value["protocol"] == PROTOCOL
            && value["proof"]
                == readiness_proof(&self.token, &format!("ready-response:{challenge}"))
    }
}

/// What a request signature covers; the server rebuilds the same string.
fn request_message(method: &str, target: &str, nonce: &str, timestamp: &str) -> String {
    format!("request:{method}\n{target}\n{nonce}\n{timestamp}")
}

fn readiness_proof(token: &str, message: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[tauri::command]
pub async fn pulse_api_request(
    window: WebviewWindow,
    state: State<'_, PulseTransport>,
    request: ApiRequest,
) -> Result<ApiResponse, String> {
    if window.label() != "main"
        || !crate::is_pulse_identifier(&window.app_handle().config().identifier)
    {
        return Err("This window cannot access Pulse operations.".into());
    }
    validate_request(&request)?;
    let transport = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !transport.ready() { return Err("The desktop service is unavailable. Restart Pulse Metric Studio and inspect Activity before repeating a change.".into()); }
        transport.send(&request.method, &request.path, request.body, request_timeout(&request.method, &request.path))
    })
        .await.map_err(|_| "Desktop request was interrupted.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    fn request(path: &str) -> ApiRequest {
        ApiRequest {
            method: "GET".into(),
            path: path.into(),
            body: None,
        }
    }
    #[test]
    fn rejects_escape_and_non_pulse_surfaces() {
        for path in [
            "https://example.com/api/pulse",
            "//example.com/api/pulse",
            "/api/unsupported/status",
            "/api/desktop/ready",
            "/api/pulse/../next",
            "/api/pulse/%2e%2e/next",
            "/api/pulse/%252fnext",
            "/api/pulse\\next",
            "/api/pulse\r\nAuthorization:x",
            "/api/pulsex",
        ] {
            assert!(validate_request(&request(path)).is_err(), "{path}");
        }
        for path in [
            "/api/pulse/drafts",
            "/api/tableau/status",
            "/api/datasources/id/fields",
            "/api/llm/profiles",
            "/api/pulse/dimensions/a%20b/values?q=x%2Fy",
        ] {
            assert!(validate_request(&request(path)).is_ok(), "{path}");
        }
    }
    #[test]
    fn enforces_methods_and_bounded_json() {
        let mut value = request("/api/pulse/drafts");
        value.method = "CONNECT".into();
        assert!(validate_request(&value).is_err());
        value.method = "POST".into();
        value.body = Some("{}".into());
        assert!(validate_request(&value).is_ok());
        value.body = Some(format!("\"{}\"", "x".repeat(3 * 1024 * 1024)));
        assert!(validate_request(&value).is_ok());
        value.body = Some("invalid".into());
        assert!(validate_request(&value).is_err());
        value.body = Some(format!("\"{}\"", "x".repeat(MAX_BODY)));
        assert!(validate_request(&value).is_err());
    }

    fn server(
        reply: impl FnOnce(&str) -> String + Send + 'static,
    ) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut input = [0; 4096];
            let read = stream.read(&mut input).unwrap();
            stream
                .write_all(reply(std::str::from_utf8(&input[..read]).unwrap()).as_bytes())
                .unwrap();
        });
        (port, handle)
    }

    #[test]
    fn only_assistant_routes_get_the_long_timeout() {
        assert_eq!(request_timeout("POST", "/api/pulse/drafts/abc/proposals"), Duration::from_secs(330));
        assert_eq!(request_timeout("POST", "/api/llm/author"), Duration::from_secs(330));
        assert_eq!(request_timeout("POST", "/api/llm/profiles/gateway/test"), Duration::from_secs(330));
        assert_eq!(request_timeout("POST", "/api/pulse/publish"), Duration::from_secs(300));
        assert_eq!(request_timeout("GET", "/api/pulse/drafts"), Duration::from_secs(120));
        assert_eq!(request_timeout("GET", "/api/tableau/status?x=/proposals"), Duration::from_secs(120));
    }

    #[test]
    fn requests_carry_a_one_time_signature_and_never_the_token() {
        let token = "c".repeat(64);
        let secret = token.clone();
        let (port, handle) = server(move |request| {
            assert!(!request.contains(&secret));
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            let header = |name: &str| {
                request
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
                            .map(|(_, value)| value.trim().to_string())
                    })
                    .unwrap()
            };
            let expected = readiness_proof(
                &secret,
                &request_message("GET", "/api/pulse/status?q=a%20b", &header("x-pulse-nonce"), &header("x-pulse-timestamp")),
            );
            assert_eq!(header("x-pulse-signature"), expected);
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".into()
        });
        let response = PulseTransport { port, token }
            .send("GET", "/api/pulse/status?q=a%20b", None, Duration::from_secs(2))
            .unwrap();
        assert_eq!(response.status, 200);
        handle.join().unwrap();
    }

    #[test]
    fn readiness_rejects_port_impostor_without_disclosing_secret() {
        let token = "a".repeat(64);
        let checked = token.clone();
        let (port, handle) = server(move |request| {
            assert!(!request.contains(&checked));
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            "HTTP/1.1 200 OK\r\nContent-Length: 27\r\n\r\n{\"ready\":true,\"protocol\":1}".into()
        });
        assert!(!PulseTransport { port, token }.ready());
        handle.join().unwrap();
    }

    #[test]
    fn readiness_verifies_nonce_bound_backend_proof() {
        let token = "b".repeat(64);
        let secret = token.clone();
        let (port, handle) = server(move |request| {
            let challenge = request
                .split("challenge=")
                .nth(1)
                .unwrap()
                .split(' ')
                .next()
                .unwrap();
            let body = serde_json::json!({ "ready": true, "protocol": PROTOCOL,
                "proof": readiness_proof(&secret, &format!("ready-response:{challenge}")) })
            .to_string();
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
        });
        assert!(PulseTransport { port, token }.ready());
        handle.join().unwrap();
    }

    #[test]
    fn bridge_rejects_redirects_and_oversized_provider_responses() {
        for response in [
            "HTTP/1.1 302 Found\r\nLocation: http://example.com/\r\nContent-Length: 0\r\n\r\n"
                .into(),
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_RESPONSE + 1
            ),
        ] {
            let (port, handle) = server(move |_| response);
            let result = PulseTransport {
                port,
                token: "a".repeat(64),
            }
            .send("GET", "/api/pulse/status", None, Duration::from_secs(2));
            assert!(result.is_err());
            handle.join().unwrap();
        }
    }
}
