// Prevents additional console window on Windows in release, DO NOT REMOVE!!
// In headless mode we forcibly attach to the parent console (Windows-only)
// before main() so stdout pipes work when invoked from CMD/PowerShell.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Headless CLI mode short-circuit: if `-p`/`--prompt` is present in argv,
  // skip Tauri entirely, spawn the sidecar with env vars, pipe its stdout,
  // and exit with the sidecar's exit code. Otherwise fall through to the
  // normal GUI bootstrap.
  let args: Vec<String> = std::env::args().skip(1).collect();
  if app_lib::headless::has_prompt_flag(&args) {
    let code = app_lib::headless::run_headless(&args);
    std::process::exit(code);
  }
  app_lib::run();
}
