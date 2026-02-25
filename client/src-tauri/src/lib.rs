use std::fs;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::State;

#[cfg(target_os = "windows")]
const HOSTS_PATH: &str = r"C:\Windows\System32\drivers\etc\hosts";
#[cfg(not(target_os = "windows"))]
const HOSTS_PATH: &str = "/etc/hosts";
const WINDSURF_DOMAIN: &str = "server.self-serve.windsurf.com";

struct ProxyState {
    child: Mutex<Option<Child>>,
    running: Mutex<bool>,
}

#[tauri::command]
fn proxy_initialize() -> Result<String, String> {
    let content = fs::read_to_string(HOSTS_PATH).map_err(|e| format!("Failed to read hosts: {}", e))?;
    let has_entry = content.lines().any(|line| {
        let trimmed = line.trim();
        !trimmed.starts_with('#') && trimmed.contains(WINDSURF_DOMAIN)
    });
    Ok(serde_json::json!({
        "hostsModified": has_entry,
        "proxyRunning": false,
        "certInstalled": true
    }).to_string())
}

#[tauri::command]
fn proxy_run(gateway_url: String, state: State<'_, ProxyState>) -> Result<String, String> {
    // 1. Add hosts entry
    let content = fs::read_to_string(HOSTS_PATH).map_err(|e| format!("Read hosts failed: {}", e))?;
    let entry = format!("127.0.0.1 {}", WINDSURF_DOMAIN);
    if !content.lines().any(|l| l.trim() == entry) {
        let new_content = format!("{}\n{}\n", content.trim_end(), entry);
        fs::write(HOSTS_PATH, new_content).map_err(|e| format!("Write hosts failed: {}", e))?;
    }

    // 2. Start local proxy (node local-proxy.js --gateway <url>)
    let exe_dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("no parent dir")?
        .to_path_buf();

    let proxy_script = exe_dir.join("resources").join("proxy").join("local-proxy.js");
    let certs_dir = exe_dir.join("resources").join("certs");

    if proxy_script.exists() {
        let child = Command::new("node")
            .arg(&proxy_script)
            .arg("--gateway")
            .arg(&gateway_url)
            .arg("--cert-dir")
            .arg(&certs_dir)
            .spawn()
            .map_err(|e| format!("Failed to start proxy: {}", e))?;

        *state.child.lock().unwrap() = Some(child);
    }

    *state.running.lock().unwrap() = true;

    Ok(serde_json::json!({
        "ok": true,
        "message": "Proxy started"
    }).to_string())
}

#[tauri::command]
fn proxy_stop(state: State<'_, ProxyState>) -> Result<String, String> {
    // Kill proxy process
    if let Some(ref mut child) = *state.child.lock().unwrap() {
        let _ = child.kill();
    }
    *state.child.lock().unwrap() = None;
    *state.running.lock().unwrap() = false;

    Ok(serde_json::json!({"ok": true, "message": "Proxy stopped"}).to_string())
}

#[tauri::command]
fn proxy_restore(state: State<'_, ProxyState>) -> Result<String, String> {
    // Kill proxy
    if let Some(ref mut child) = *state.child.lock().unwrap() {
        let _ = child.kill();
    }
    *state.child.lock().unwrap() = None;
    *state.running.lock().unwrap() = false;

    // Remove hosts entry
    let content = fs::read_to_string(HOSTS_PATH).map_err(|e| format!("Read hosts failed: {}", e))?;
    let filtered: Vec<&str> = content
        .lines()
        .filter(|line| !line.contains(WINDSURF_DOMAIN))
        .collect();
    fs::write(HOSTS_PATH, filtered.join("\n") + "\n").map_err(|e| format!("Write hosts failed: {}", e))?;

    Ok(serde_json::json!({"ok": true, "message": "Restored"}).to_string())
}

#[tauri::command]
fn proxy_status(state: State<'_, ProxyState>) -> Result<String, String> {
    let running = *state.running.lock().unwrap();
    let content = fs::read_to_string(HOSTS_PATH).unwrap_or_default();
    let hosts_modified = content.lines().any(|l| {
        let t = l.trim();
        !t.starts_with('#') && t.contains(WINDSURF_DOMAIN)
    });

    Ok(serde_json::json!({
        "hostsModified": hosts_modified,
        "proxyRunning": running,
    }).to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(ProxyState {
            child: Mutex::new(None),
            running: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            proxy_initialize,
            proxy_run,
            proxy_stop,
            proxy_restore,
            proxy_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
