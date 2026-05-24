<!--
SPDX-License-Identifier: Apache-2.0
Copyright (c) SLR Software Solutions Inc.
-->

# ClawdUI Architecture

Cross-platform desktop GUI for [Claude Code](https://docs.claude.com/en/docs/claude-code), wrapping the official Claude Agent SDK in a native window. ClawdUI ships **three** processes that talk over plain stdio — no embedded HTTP server, no hidden daemons, no cloud component owned by the project.

## Layered diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 1 — Native window (Tauri 2.x, Rust)                           │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │ Layer 2 — Webview UI (Svelte 5 + TypeScript + Vite)         │   │
│   │   • Sidebar  • Composer  • Fleet View                       │   │
│   │   • Settings panel (every SDK Options field)                │   │
│   │   • Slash menu (19 commands)                                │   │
│   │   • Hooks debugger / Checkpoints / Plan mode                │   │
│   │   • localStorage-backed settings store                      │   │
│   └────────────────────────────────────────────────────┬────────┘   │
│                                                        │            │
│   Rust backend (tauri-app)                             │            │
│     • spawn_sidecar()      stdin  Mutex<ChildStdin>    │            │
│     • emit("sidecar-event") ◀── stdout reader thread ──┘            │
│     • emit("sidecar-stderr")◀── stderr reader thread                │
│     • headless launcher (clawdui -p "...")                          │
└─────────────────────────────────────┬───────────────────────────────┘
                                      │ newline-delimited JSON over stdio
┌─────────────────────────────────────┴───────────────────────────────┐
│ Layer 3 — Sidecar (Node ≥ 18, TypeScript)                           │
│   • readline → InboundMessage dispatch                              │
│   • Session class wraps one SDK Query (long-lived per session)      │
│   • MessageQueue: AsyncIterable<SDKUserMessage>                     │
│   • Hooks runtime, MCP loader, checkpoint store                     │
│   • Optional WebSocket relay client (mobile pair feature)           │
│   • @anthropic-ai/claude-agent-sdk → query()                        │
└─────────────────────────────────────┬───────────────────────────────┘
                                      │ HTTPS (Anthropic SDK)
                                      ▼
                              Anthropic API / Claude
```

## Layer responsibilities

| Layer | Tech | Job |
|-------|------|-----|
| 1. Shell | Tauri 2.x + Rust | Spawn the sidecar, own the window, bridge stdio ↔ webview events. Headless launcher lives here. |
| 2. UI | Svelte 5 + Vite + TS | Render messages, manage settings, route slash commands, surface tool calls + permission prompts. |
| 3. Agent | Node + `@anthropic-ai/claude-agent-sdk` | One long-lived `query()` per session. Streaming-input mode keeps context across turns. |

## Why streaming input

The Agent SDK exposes two driving modes:

| Mode | When | Behavior |
|------|------|----------|
| String prompt | One-shot, fire-and-forget | Stateless. Each call resets the session. |
| **AsyncIterable&lt;SDKUserMessage&gt;** | Multi-turn chat | One long-lived session: SDK retains context, runs tool loops, surfaces permission prompts, supports interrupts. |

ClawdUI uses streaming input. A single `query()` drives an entire conversation — the sidecar pushes new user messages into the iterable as you type, and the SDK keeps the session warm.

## Session storage

Sessions are written by the SDK to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` — **the same path the `claude` CLI uses**. This is the interop contract: any session started in the GUI can be resumed from the CLI with `claude --resume`, and vice versa. ClawdUI does not maintain a parallel session database.

## IPC contract

All messages between the Rust shell and the Node sidecar are **single-line JSON** terminated by `\n`. This is:

- trivially debuggable (`tail -f` the log, pipe through `jq`),
- language-agnostic (the sidecar could be reimplemented in any runtime),
- and has zero extra runtime dependencies on either side.

Inbound messages (UI → sidecar) include: `start_session`, `send_user_message`, `interrupt`, `set_permission_mode`, `set_model`, `apply_settings`, `set_remote_control`. Outbound events (sidecar → UI) include: `session_started`, `assistant_message`, `tool_use`, `tool_result`, `permission_request`, `error`, `session_complete`.

## Headless mode

`clawdui -p "..."` is a thin path through Layer 1 that:

1. Validates args in Rust.
2. Spawns the sidecar with `CLAWDUI_HEADLESS=1` and the prompt + options as env vars.
3. The sidecar bypasses the JSON-RPC loop, builds a Query, streams events to stdout, then exits.

Persisted settings (MCP servers, permission mode, system prompt, hooks) are applied identically to interactive mode. Precedence: CLI flag &gt; env &gt; settings &gt; default.

## Remote control (mobile pair)

An optional sidecar feature mirrors the local JSON-RPC stream through a WebSocket relay so a second peer (phone, tablet, another laptop) can drive the same session. The relay is a ~30-line server you host yourself; ClawdUI ships only the client. See [`docs/REMOTE_CONTROL_PROTOCOL.md`](docs/REMOTE_CONTROL_PROTOCOL.md).
