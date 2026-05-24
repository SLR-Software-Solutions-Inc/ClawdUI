<!--
SPDX-License-Identifier: Apache-2.0
Copyright (c) SLR Software Solutions Inc.
-->

# ClawdUI — Remote Control Relay Protocol (v0)

ClawdUI's "remote control" mode exposes a local sidecar session through a
WebSocket relay so the same JSON-RPC stream can be observed and driven from
another browser/device. The relay is **dumb** — it routes opaque frames
between authenticated peers that share a `sessionName` + `authToken`. ClawdUI
ships only the **client**; you (or someone you trust) host the relay.

Use case: open a session on your laptop, then drive it from your phone, a
tablet, or another machine on a flight.

## Trust model

| Actor | Trust | Notes |
|---|---|---|
| Relay operator | trusted-ish | Sees framed traffic. Run your own to be safe. |
| Co-located peer with token | full control | Token = root credential of the session. |
| Network observer (no TLS) | reads everything | Always use `wss://`. |

The token is generated in-app via `crypto.getRandomValues` (32 bytes hex).
**Treat it like an SSH private key.** Regenerate after every share.

## Frame schema

All frames are JSON objects, one per WebSocket message.

| `type` | Direction | Required fields | Purpose |
|---|---|---|---|
| `register` | peer → relay | `sessionName`, `authToken`, `role` (`"host"` \| `"client"`) | Authenticate. Must be the first frame. |
| `forward` | both | `direction` (`"rpc"` \| `"event"`), `payload` (any JSON) | Carries opaque ClawdUI JSON-RPC. Relay routes to all OTHER peers in the same session. |
| `keepalive` | both | (none) | App-level ping every ~25s. Relay may drop or echo. |
| `error` | relay → peer | `error` (string) | Auth failure, dup session collision, server hiccups. Peer should disconnect. |

### `forward.direction` semantics

`direction` is metadata so the relay (and curious humans) can tell whether a
payload was an inbound RPC the host received from its local UI or an event the
host emitted to its local UI:

- `"rpc"` — payload originated as a local-UI → sidecar request. Remote peers
  treat it as an inbound RPC they would otherwise type themselves.
- `"event"` — payload is a sidecar → UI event. Remote peers render it the same
  way the local UI does.

The relay **does not interpret payloads** — it only checks the registration
envelope.

## Routing rules (relay must implement)

1. Before `register`, drop everything.
2. `register` must contain a non-empty `sessionName` + `authToken`. The first
   peer to register a name reserves it; subsequent peers must present the same
   token to join. Mismatched token → send `error` + close.
3. On `forward` from peer P, broadcast verbatim to all OTHER peers registered
   on the same `sessionName`.
4. On `keepalive`, no-op (or echo `keepalive`).
5. On disconnect, drop from membership. Do NOT close the session — other peers
   stay connected.
6. Optionally enforce a per-session peer cap (e.g. 8) to limit fan-out.

## Reference relay implementation (Node + ws)

Save as `relay.js`, run with `node relay.js` (listens on port 9999).

```js
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 9999);
const sessions = new Map(); // name -> { token, peers: Set<WebSocket> }

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (ws) => {
  let joined = null; // { name, set }
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!joined) {
      if (m.type !== "register" || !m.sessionName || !m.authToken) {
        ws.send(JSON.stringify({ type: "error", error: "register required" }));
        ws.close(); return;
      }
      const existing = sessions.get(m.sessionName);
      if (existing && existing.token !== m.authToken) {
        ws.send(JSON.stringify({ type: "error", error: "bad token" }));
        ws.close(); return;
      }
      const entry = existing ?? { token: m.authToken, peers: new Set() };
      entry.peers.add(ws);
      sessions.set(m.sessionName, entry);
      joined = { name: m.sessionName, set: entry.peers };
      return;
    }
    if (m.type === "forward") {
      for (const peer of joined.set) if (peer !== ws && peer.readyState === 1) peer.send(raw.toString());
    }
  });
  ws.on("close", () => {
    if (!joined) return;
    joined.set.delete(ws);
    if (joined.set.size === 0) sessions.delete(joined.name);
  });
});
console.log(`relay listening on :${PORT}`);
```

That is the entire server: ~30 lines, no dependencies beyond `ws`. It is
intentionally minimal — bring your own TLS terminator (Caddy, nginx, Cloudflare
Tunnel) for `wss://`.

## Client behavior (for reference)

The ClawdUI sidecar (`sidecar/relay.ts`) acts as the **host** peer:

- Connects on `set_remote_control { enabled: true, ... }` from the local UI.
- Sends `register` with `role: "host"`.
- Mirrors every inbound stdin RPC (except RC-control RPCs) as `forward {direction: "rpc"}`.
- Mirrors every outbound stdout event (except `remote_control_state`) as `forward {direction: "event"}`.
- Treats every received `forward {direction: "rpc"}` as if it had arrived on
  stdin from the local UI.
- Reconnects with exponential backoff (1s → 30s cap).

A web client peer would do the inverse:

- Send `register` with `role: "client"`.
- On `forward {direction: "event"}`, render to its UI.
- On user input, send `forward {direction: "rpc", payload: <JSON-RPC msg>}`.

## Versioning

This document describes **v0**. Backwards-incompatible frame changes will bump
the version embedded in `register` (`"protocol": 1` etc.). v0 has no version
field; relays should accept it as the implicit baseline.
