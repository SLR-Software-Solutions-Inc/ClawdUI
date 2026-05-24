//! Headless CLI mode. Lets `clawdui -p "..."` stand in for the upstream
//! `claude` CLI in shell pipelines / CI. We never construct a Tauri context;
//! instead, parse argv, spawn the Node sidecar with `CLAWDUI_HEADLESS=1`,
//! stream its stdout to ours, then exit with its code.
//!
//! Supported flags (matched to Claude CLI):
//!   -p, --prompt <text>
//!       --json                 (alias for --output-format=json)
//!       --model <id>
//!       --output-format <text|json|stream-json>
//!       --max-turns <n>
//!       --cwd <path>
//!       --allowed-tools <a,b,c>
//!       --permission-mode <default|acceptEdits|bypassPermissions|plan>
//!   -h, --help
//!
//! Exit codes: 0 success, 1 runtime error, 2 invalid args.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;

const HELP: &str = "\
clawdui [headless mode]

Usage:
  clawdui -p \"your prompt here\" [flags]

Flags:
  -p, --prompt <text>             Prompt to send (required to enter headless mode)
      --json                      Shortcut for --output-format=json
      --model <id>                Model override
      --output-format <fmt>       text | json | stream-json   (default: text)
      --max-turns <n>             Limit conversation turns
      --cwd <path>                Working directory for the agent
      --allowed-tools <list>      Comma-separated tool allowlist
      --permission-mode <mode>    default | acceptEdits | bypassPermissions | plan
  -h, --help                      Show this help and exit

Exit codes: 0 ok, 1 error, 2 invalid args.
";

/// Quick pre-scan so `main()` can decide whether to enter GUI mode without
/// running the full parser. Cheap, side-effect-free.
pub fn has_prompt_flag(args: &[String]) -> bool {
    for a in args {
        if a == "-p"
            || a == "--prompt"
            || a.starts_with("--prompt=")
            || a == "-h"
            || a == "--help"
        {
            return true;
        }
    }
    false
}

struct Parsed {
    prompt: String,
    model: Option<String>,
    output_format: String,
    max_turns: Option<String>,
    cwd: Option<String>,
    allowed_tools: Option<String>,
    permission_mode: Option<String>,
}

fn parse(args: &[String]) -> Result<Parsed, String> {
    let mut prompt: Option<String> = None;
    let mut model: Option<String> = None;
    let mut output_format: Option<String> = None;
    let mut max_turns: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut allowed_tools: Option<String> = None;
    let mut permission_mode: Option<String> = None;
    let mut json_flag = false;

    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        let take_next = |i: &mut usize, name: &str| -> Result<String, String> {
            *i += 1;
            args.get(*i)
                .cloned()
                .ok_or_else(|| format!("flag {name} requires a value"))
        };
        match a.as_str() {
            "-h" | "--help" => {
                print!("{HELP}");
                std::process::exit(0);
            }
            "-p" | "--prompt" => {
                prompt = Some(take_next(&mut i, "--prompt")?);
            }
            "--json" => {
                json_flag = true;
            }
            "--model" => {
                model = Some(take_next(&mut i, "--model")?);
            }
            "--output-format" => {
                output_format = Some(take_next(&mut i, "--output-format")?);
            }
            "--max-turns" => {
                max_turns = Some(take_next(&mut i, "--max-turns")?);
            }
            "--cwd" => {
                cwd = Some(take_next(&mut i, "--cwd")?);
            }
            "--allowed-tools" => {
                allowed_tools = Some(take_next(&mut i, "--allowed-tools")?);
            }
            "--permission-mode" => {
                permission_mode = Some(take_next(&mut i, "--permission-mode")?);
            }
            other if other.starts_with("--prompt=") => {
                prompt = Some(other["--prompt=".len()..].to_string());
            }
            other if other.starts_with("--model=") => {
                model = Some(other["--model=".len()..].to_string());
            }
            other if other.starts_with("--output-format=") => {
                output_format = Some(other["--output-format=".len()..].to_string());
            }
            other if other.starts_with("--max-turns=") => {
                max_turns = Some(other["--max-turns=".len()..].to_string());
            }
            other if other.starts_with("--cwd=") => {
                cwd = Some(other["--cwd=".len()..].to_string());
            }
            other if other.starts_with("--allowed-tools=") => {
                allowed_tools = Some(other["--allowed-tools=".len()..].to_string());
            }
            other if other.starts_with("--permission-mode=") => {
                permission_mode = Some(other["--permission-mode=".len()..].to_string());
            }
            other => {
                return Err(format!("unknown flag: {other}"));
            }
        }
        i += 1;
    }

    let prompt = prompt.ok_or_else(|| "--prompt is required".to_string())?;
    if prompt.trim().is_empty() {
        return Err("--prompt cannot be empty".to_string());
    }
    let output_format = match output_format {
        Some(s) => {
            let s = s.trim().to_string();
            if s != "text" && s != "json" && s != "stream-json" {
                return Err(format!(
                    "--output-format must be text|json|stream-json, got: {s}"
                ));
            }
            s
        }
        None => {
            if json_flag {
                "json".to_string()
            } else {
                "text".to_string()
            }
        }
    };
    if let Some(ref n) = max_turns {
        if n.parse::<u32>().is_err() {
            return Err(format!("--max-turns must be a non-negative integer, got: {n}"));
        }
    }
    if let Some(ref pm) = permission_mode {
        let pm_t = pm.trim();
        match pm_t {
            "default" | "acceptEdits" | "bypassPermissions" | "plan" => {}
            _ => {
                return Err(format!(
                    "--permission-mode must be default|acceptEdits|bypassPermissions|plan, got: {pm_t}"
                ));
            }
        }
    }

    Ok(Parsed {
        prompt,
        model,
        output_format,
        max_turns,
        cwd,
        allowed_tools,
        permission_mode,
    })
}

/// Locate the sidecar bundle the same way the Tauri runtime does, but without
/// an AppHandle (we never construct one in headless mode).
fn resolve_sidecar_script() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CLAWDUI_SIDECAR") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    // 1. Walk up from the executable location (covers .app bundle layout:
    //    Contents/MacOS/clawdui  →  Contents/Resources/sidecar/dist/index.js).
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(PathBuf::from);
        for _ in 0..6 {
            if let Some(p) = cur.clone() {
                // macOS .app bundled resources
                let macos_res = p.join("../Resources/sidecar/dist/index.js");
                if macos_res.exists() {
                    return Some(macos_res);
                }
                // sibling layout (linux/windows portable / dev cargo target)
                let sibling = p.join("sidecar/dist/index.js");
                if sibling.exists() {
                    return Some(sibling);
                }
                cur = p.parent().map(PathBuf::from);
            } else {
                break;
            }
        }
    }
    // 2. Walk up from CWD (dev: cargo run from repo root or src-tauri/).
    if let Ok(cwd) = std::env::current_dir() {
        for parent in [cwd.clone(), cwd.join(".."), cwd.join("../..")] {
            let c = parent.join("sidecar/dist/index.js");
            if c.exists() {
                return Some(c);
            }
        }
    }
    // 3. Build-time manifest fallback.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mf = manifest.join("../sidecar/dist/index.js");
    if mf.exists() {
        return Some(mf);
    }
    None
}

fn find_node() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CLAWDUI_NODE") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Ok(path_var) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path_var.split(sep) {
            if dir.is_empty() {
                continue;
            }
            let c = PathBuf::from(dir).join(if cfg!(windows) { "node.exe" } else { "node" });
            if c.is_file() {
                return Some(c);
            }
        }
    }
    let mut extras: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        extras.push(home.join(".npm-global/bin/node"));
        extras.push(home.join(".volta/bin/node"));
        let nvm_root = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_root) {
            let mut versions: Vec<PathBuf> =
                entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
            versions.sort();
            if let Some(latest) = versions.last() {
                extras.push(latest.join("bin/node"));
            }
        }
    }
    extras.into_iter().find(|p| p.is_file())
}

pub fn run_headless(args: &[String]) -> i32 {
    let parsed = match parse(args) {
        Ok(p) => p,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "clawdui: {e}\n\n{HELP}");
            return 2;
        }
    };

    let script = match resolve_sidecar_script() {
        Some(p) => p,
        None => {
            let _ = writeln!(
                std::io::stderr(),
                "clawdui: sidecar bundle not found. Build it with `npm run sidecar:build` or set CLAWDUI_SIDECAR=/path/to/index.js"
            );
            return 1;
        }
    };
    let node = match find_node() {
        Some(p) => p,
        None => {
            let _ = writeln!(
                std::io::stderr(),
                "clawdui: node binary not found. Install Node.js or set CLAWDUI_NODE=/path/to/node"
            );
            return 1;
        }
    };

    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .env("CLAWDUI_HEADLESS", "1")
        .env("CLAWDUI_PROMPT", &parsed.prompt)
        .env("CLAWDUI_OUTPUT_FORMAT", &parsed.output_format)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(ref m) = parsed.model {
        cmd.env("CLAWDUI_MODEL", m);
    }
    if let Some(ref n) = parsed.max_turns {
        cmd.env("CLAWDUI_MAX_TURNS", n);
    }
    if let Some(ref c) = parsed.cwd {
        cmd.env("CLAWDUI_CWD", c);
    }
    if let Some(ref t) = parsed.allowed_tools {
        cmd.env("CLAWDUI_ALLOWED_TOOLS", t);
    }
    if let Some(ref pm) = parsed.permission_mode {
        cmd.env("CLAWDUI_PERMISSION_MODE", pm);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "clawdui: spawn sidecar failed: {e}");
            return 1;
        }
    };

    // Stream child stdout → ours, line by line, no buffering surprises.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let t_out = stdout.map(|s| {
        thread::spawn(move || {
            let reader = BufReader::new(s);
            let mut out = std::io::stdout().lock();
            for line in reader.lines().map_while(Result::ok) {
                let _ = writeln!(out, "{line}");
                let _ = out.flush();
            }
        })
    });
    let t_err = stderr.map(|s| {
        thread::spawn(move || {
            let reader = BufReader::new(s);
            let mut err = std::io::stderr().lock();
            for line in reader.lines().map_while(Result::ok) {
                let _ = writeln!(err, "{line}");
                let _ = err.flush();
            }
        })
    });

    let status = match child.wait() {
        Ok(s) => s,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "clawdui: wait sidecar failed: {e}");
            return 1;
        }
    };
    if let Some(h) = t_out {
        let _ = h.join();
    }
    if let Some(h) = t_err {
        let _ = h.join();
    }
    status.code().unwrap_or(1)
}
