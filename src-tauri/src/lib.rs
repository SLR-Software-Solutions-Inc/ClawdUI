mod pty;
pub mod headless;

use parking_lot::Mutex;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use pty::PtyManager;

/// Append-only logger that mirrors every sidecar stdout/stderr line to disk
/// so a stalled or force-killed session leaves post-mortem evidence behind.
/// Cheap 5 MB rolling cutoff — rename to `.1` and start fresh.
struct SidecarLogger {
    path: PathBuf,
    file: Mutex<File>,
}

const SIDECAR_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

impl SidecarLogger {
    fn open(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("sidecar.log");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        Ok(Self {
            path,
            file: Mutex::new(file),
        })
    }

    fn append(&self, stream: &str, line: &str) {
        let ts = iso8601_now();
        let mut guard = self.file.lock();
        // Best-effort: never panic on a logging failure.
        let _ = writeln!(guard, "[{ts}] [{stream}] {line}");
        // Cheap roll check — stat the handle each line; fine for sidecar
        // volume which is bursty but never hot-loop fast.
        if let Ok(meta) = guard.metadata() {
            if meta.len() > SIDECAR_LOG_MAX_BYTES {
                let rolled = self.path.with_extension("log.1");
                // Drop the current handle, rename, reopen fresh.
                let _ = std::fs::rename(&self.path, &rolled);
                if let Ok(fresh) = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)
                {
                    *guard = fresh;
                }
            }
        }
    }
}

/// Minimal RFC3339-ish UTC timestamp without pulling in chrono.
/// Format: `YYYY-MM-DDTHH:MM:SS.sssZ`
fn iso8601_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let millis = now.subsec_millis();

    // Days since 1970-01-01.
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let hour = (secs_of_day / 3600) as u32;
    let min = ((secs_of_day % 3600) / 60) as u32;
    let sec = (secs_of_day % 60) as u32;

    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, hour, min, sec, millis
    )
}

struct Sidecar {
    stdin: Mutex<ChildStdin>,
}

/// Locate the `node` binary across common install locations.
///
/// When ClawdUI is launched from Finder/Dock the inherited `PATH` is the
/// minimal `/usr/bin:/bin:/usr/sbin:/sbin` — Homebrew's
/// `/opt/homebrew/bin`, `/usr/local/bin`, nvm shims, and asdf shims are
/// invisible. `Command::new("node")` therefore fails with `ENOENT` and the
/// sidecar never starts. Mirror the `findOnPath` helper used inside
/// `sidecar/index.ts` so the Rust side resolves the same set of locations.
fn find_node() -> Option<PathBuf> {
    // 1. Honour explicit override first.
    if let Ok(p) = std::env::var("CLAWDUI_NODE") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }

    // 2. Walk the inherited PATH (covers most dev/launchctl scenarios).
    if let Ok(path_var) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path_var.split(sep) {
            if dir.is_empty() {
                continue;
            }
            let candidate = PathBuf::from(dir).join("node");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 3. Fall back to the well-known macOS / Linux install locations that
    //    Finder/Dock launches never see.
    let mut extras: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        // ~/.npm-global typically holds the symlink for nvm-managed installs
        // when users `npm i -g`. Check it before scanning nvm versions.
        extras.push(home.join(".npm-global/bin/node"));
        extras.push(home.join(".volta/bin/node"));

        // Pick the newest entry under ~/.nvm/versions/node/* if present.
        let nvm_root = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_root) {
            let mut versions: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            // Lexicographic sort is good enough for vXX.Y.Z and yields the
            // highest version last.
            versions.sort();
            if let Some(latest) = versions.last() {
                extras.push(latest.join("bin/node"));
            }
        }
    }

    extras.into_iter().find(|p| p.is_file())
}

fn resolve_sidecar_script(app: &AppHandle) -> PathBuf {
    // 1. Explicit override always wins (dev / CI scenarios).
    if let Ok(env_path) = std::env::var("CLAWDUI_SIDECAR") {
        return PathBuf::from(env_path);
    }

    // 2. Bundled resource path (production .app / .AppImage / .exe).
    //    `bundle.resources` in tauri.conf.json copies sidecar/dist into
    //    Contents/Resources/sidecar/dist on macOS.
    if let Ok(res_dir) = app.path().resource_dir() {
        let bundled = res_dir.join("sidecar/dist/index.js");
        if bundled.exists() {
            return bundled;
        }
    }

    // 3. Walk up from CWD (legacy `cargo run` workflow).
    if let Ok(cwd) = std::env::current_dir() {
        for parent in [cwd.clone(), cwd.join(".."), cwd.join("../..")] {
            let candidate = parent.join("sidecar/dist/index.js");
            if candidate.exists() {
                return candidate;
            }
        }
    }

    // 4. Fall back to the build-time manifest dir. May not exist at runtime
    //    (e.g. when the build host's path is baked in) — caller checks
    //    `.exists()` and reports a non-fatal error.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.join("../sidecar/dist/index.js")
}

fn spawn_sidecar(app: &AppHandle) -> Result<Sidecar, String> {
    let script = resolve_sidecar_script(app);
    if !script.exists() {
        return Err(format!("sidecar script not found at {}", script.display()));
    }

    // Resolve `node` against well-known locations because Finder/Dock launches
    // inherit only the minimal `/usr/bin:/bin:/usr/sbin:/sbin` PATH. Without
    // this, `Command::new("node")` returns ENOENT and the sidecar never
    // starts in the bundled .app.
    let node_bin = find_node()
        .ok_or_else(|| {
            "node binary not found (looked in PATH, /opt/homebrew/bin, /usr/local/bin, \
             /usr/bin, ~/.npm-global/bin, ~/.volta/bin, ~/.nvm/versions/node/*). \
             Install Node.js or set CLAWDUI_NODE=/path/to/node."
                .to_string()
        })?;
    log::info!("sidecar: using node at {}", node_bin.display());
    log::info!("sidecar: script at {}", script.display());

    // GlitchTip / Sentry DSN baked at build time via the GLITCHTIP_DSN env var
    // (CI: Forgejo Actions secret -> workflow env -> tauri build -> rustc).
    // Local dev builds without the var get an empty string, which the sidecar's
    // Sentry init treats as "no DSN" -> no-op. Same for the bundled app version.
    // Inherits the rest of the parent env (PATH, HOME, ...).
    const BUILD_GLITCHTIP_DSN: &str = match option_env!("GLITCHTIP_DSN") {
        Some(v) => v,
        None => "",
    };
    const BUILD_CLAWDUI_VERSION: &str = match option_env!("CLAWDUI_VERSION") {
        Some(v) => v,
        None => env!("CARGO_PKG_VERSION"),
    };

    let mut cmd = Command::new(&node_bin);
    cmd.arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !BUILD_GLITCHTIP_DSN.is_empty() {
        cmd.env("GLITCHTIP_DSN", BUILD_GLITCHTIP_DSN);
    }
    cmd.env("CLAWDUI_VERSION", BUILD_CLAWDUI_VERSION);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {} failed: {e}", node_bin.display()))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "no stdin on sidecar".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout on sidecar".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr on sidecar".to_string())?;

    // Resolve a per-OS app log dir and open the rolling sidecar log. Failure
    // here is non-fatal — the event stream to the frontend keeps working.
    let logger: Option<Arc<SidecarLogger>> = app
        .path()
        .app_log_dir()
        .ok()
        .and_then(|dir| match SidecarLogger::open(&dir) {
            Ok(l) => {
                log::info!("sidecar: log file at {}", l.path.display());
                Some(Arc::new(l))
            }
            Err(e) => {
                log::warn!("sidecar: could not open log file in {}: {e}", dir.display());
                None
            }
        });

    let app_out = app.clone();
    let log_out = logger.clone();
    thread::spawn(move || {
        // Default BufReader capacity is 8 KB which is fine for typical
        // RPC traffic but triggers repeated growth-reallocation on a
        // single multi-hundred-KB line (e.g. a `message` event carrying
        // an SDK assistant payload during resume replay). Pre-size to
        // 1 MB so the common large-line case is a single copy.
        let reader = BufReader::with_capacity(1024 * 1024, stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            if let Some(l) = &log_out {
                // [DIAG] truncate log writes to keep the on-disk log
                // bounded even when individual events are large. The
                // sidecar caps emit at ~256 KB so this is a belt-and-
                // suspenders guard.
                if line.len() > 4096 {
                    l.append("stdout", &format!("{}…[+{} bytes]", &line[..4096], line.len() - 4096));
                } else {
                    l.append("stdout", &line);
                }
            }
            let payload: serde_json::Value =
                serde_json::from_str(&line).unwrap_or_else(|_| serde_json::json!({"raw": line}));
            let _ = app_out.emit("sidecar-event", payload);
        }
    });

    let app_err = app.clone();
    let log_err = logger.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(l) = &log_err {
                l.append("stderr", &line);
            }
            let _ = app_err.emit(
                "sidecar-stderr",
                serde_json::json!({ "line": line }),
            );
        }
    });

    let _waiter = thread::spawn(move || {
        let _ = child.wait();
    });

    Ok(Sidecar {
        stdin: Mutex::new(stdin),
    })
}

#[tauri::command]
fn open_in_external_editor(
    path: String,
    line: Option<u32>,
    col: Option<u32>,
    exec: String,
    args: Vec<String>,
) -> Result<(), String> {
    if exec.trim().is_empty() {
        return Err("exec is empty".to_string());
    }
    if path.trim().is_empty() {
        return Err("path is empty".to_string());
    }
    let line_s = line.map(|n| n.to_string()).unwrap_or_else(|| "1".to_string());
    let col_s = col.map(|n| n.to_string()).unwrap_or_else(|| "1".to_string());

    // Token substitution is best-effort here as a safety net; the frontend
    // already substitutes. We do NOT shell-interpret args; each element is
    // passed as a separate argv entry to std::process::Command.
    let resolved: Vec<String> = args
        .into_iter()
        .map(|a| {
            a.replace("{path}", &path)
                .replace("{line}", &line_s)
                .replace("{col}", &col_s)
        })
        .collect();

    let mut cmd = Command::new(&exec);
    cmd.args(&resolved);
    // Detach: don't inherit our stdio so editor windows aren't tied to our pipe.
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    cmd.spawn()
        .map(|_child| ())
        .map_err(|e| format!("spawn '{}' failed: {e}", exec))
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    // Validate scheme so a stray invocation can't shell out arbitrary args.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("refusing non-http(s) url: {url}"));
    }
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    cmd.arg(&url);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("open_external spawn failed: {e}"))
}

#[tauri::command]
fn send_to_sidecar(
    payload: String,
    sidecar: State<'_, Option<Arc<Sidecar>>>,
) -> Result<(), String> {
    let sidecar = sidecar
        .as_ref()
        .ok_or_else(|| "sidecar is not running".to_string())?;
    let mut guard = sidecar.stdin.lock();
    guard
        .write_all(payload.as_bytes())
        .and_then(|_| guard.write_all(b"\n"))
        .and_then(|_| guard.flush())
        .map_err(|e| format!("write failed: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let handle = app.handle();
            // Non-fatal: a sidecar failure must never abort startup. A panic
            // returned from `setup` propagates out of tao's extern "C"
            // `did_finish_launching` callback, which trips
            // `panic_cannot_unwind` -> SIGABRT before any window appears.
            // Surface the error to the user via an event instead so the UI
            // can render and show a recoverable error state.
            let sidecar_state: Option<Arc<Sidecar>> = match spawn_sidecar(handle) {
                Ok(sidecar) => Some(Arc::new(sidecar)),
                Err(e) => {
                    log::error!("sidecar spawn failed (continuing without it): {e}");
                    let _ = handle.emit(
                        "sidecar-error",
                        serde_json::json!({ "message": e }),
                    );
                    None
                }
            };
            app.manage(sidecar_state);
            app.manage(Arc::new(PtyManager::new()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_to_sidecar,
            open_in_external_editor,
            open_external,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
