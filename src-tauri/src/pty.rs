// Native PTY pane backend.
//
// Each session is keyed by a UUID. The frontend opens a session with
// `pty_spawn`, which:
//   1. Creates a PTY pair via portable-pty.
//   2. Spawns the user's default shell ($SHELL on unix, COMSPEC/cmd.exe on Windows).
//   3. Spawns a reader thread that emits `pty-data:<id>` Tauri events
//      with raw stdout chunks (lossy UTF-8).
//
// The frontend writes input with `pty_write`, resizes with `pty_resize`,
// and closes with `pty_kill`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Per-session state held by `PtyManager`.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Serialize, Clone)]
struct PtyDataPayload {
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExitPayload {
    code: Option<i32>,
}

fn default_shell(override_shell: Option<String>) -> (String, Vec<String>) {
    if let Some(s) = override_shell {
        return (s, Vec::new());
    }
    #[cfg(windows)]
    {
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        (shell, Vec::new())
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        // Login + interactive so the user gets their normal prompt / aliases.
        (shell, vec!["-l".to_string()])
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: State<'_, Arc<PtyManager>>,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    shell: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let (program, args) = default_shell(shell);
    let mut cmd = CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.cwd(dir);
        }
    }
    // Sensible terminal env defaults.
    cmd.env("TERM", "xterm-256color");
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell failed: {e}"))?;
    // Slave is no longer needed in this process once the child has it.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let event_data = format!("pty-data:{id}");
    let event_exit = format!("pty-exit:{id}");

    {
        let mut sessions = manager.sessions.lock();
        sessions.insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    // Reader thread: stream stdout chunks to the frontend.
    let app_clone = app.clone();
    let manager_clone: Arc<PtyManager> = Arc::clone(&manager);
    let id_clone = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(&event_data, PtyDataPayload { data: chunk });
                }
                Err(e) => {
                    log::debug!("pty reader {id_clone} ended: {e}");
                    break;
                }
            }
        }
        // Try to reap the child so we can report exit status.
        let exit_code = {
            let mut sessions = manager_clone.sessions.lock();
            sessions
                .get_mut(&id_clone)
                .and_then(|s| s.child.try_wait().ok().flatten())
                .map(|s| s.exit_code() as i32)
        };
        let _ = app_clone.emit(&event_exit, PtyExitPayload { code: exit_code });
        // Drop session from the manager.
        manager_clone.sessions.lock().remove(&id_clone);
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(
    manager: State<'_, Arc<PtyManager>>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock();
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("unknown pty session: {id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| format!("pty write failed: {e}"))
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, Arc<PtyManager>>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = manager.sessions.lock();
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("unknown pty session: {id}"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, Arc<PtyManager>>, id: String) -> Result<(), String> {
    let mut sessions = manager.sessions.lock();
    if let Some(mut session) = sessions.remove(&id) {
        // Best-effort kill; drop master afterwards to release fds.
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}
