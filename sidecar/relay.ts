/**
 * Remote Control relay client for ClawdUI sidecar.
 *
 * Opens a WebSocket to a user-specified relay URL and:
 *   1. authenticates with { type: "register", sessionName, authToken, role: "host" }
 *   2. forwards every local→sidecar JSON-RPC request and every sidecar→frontend
 *      event ALSO to the relay (wrapped in a `forward` frame)
 *   3. accepts `forward` frames from the relay (originated by a remote client)
 *      and routes their JSON-RPC payload back through the local message handler,
 *      so the same session is observable + drivable from any peer that holds
 *      the same session token.
 *
 * Reconnects with exponential backoff. NEVER blocks the local stdio path.
 * The relay protocol is documented in docs/REMOTE_CONTROL_PROTOCOL.md.
 */
import WebSocket from "ws";

export type RelayConfig = {
  url: string;
  sessionName: string;
  authToken: string;
};

type RelayFrame =
  | {
      type: "register";
      sessionName: string;
      authToken: string;
      role: "host" | "client";
    }
  | { type: "forward"; direction: "rpc" | "event"; payload: unknown }
  | { type: "keepalive" }
  | { type: "error"; error: string };

export type RelayState =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "error"; error: string };

export class RelayClient {
  private cfg: RelayConfig;
  private ws: WebSocket | null = null;
  private backoffMs = 1000;
  private readonly maxBackoffMs = 30_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  state: RelayState = { kind: "disconnected" };
  forwardedCount = 0;

  /** Called when an inbound RPC arrives from a remote peer; sidecar should
   *  treat the payload exactly as if it came from local stdin. */
  onRemoteRpc: (payload: unknown) => void = () => {};
  /** Called whenever the connection state changes — for UI status. */
  onStateChange: (state: RelayState) => void = () => {};

  constructor(cfg: RelayConfig) {
    this.cfg = cfg;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setState({ kind: "disconnected" });
  }

  /** Forward a frame originated locally (either an inbound RPC the local
   *  frontend sent, or an event the sidecar emitted). Direction is metadata
   *  for the relay; the payload is opaque JSON. */
  forward(direction: "rpc" | "event", payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const frame: RelayFrame = { type: "forward", direction, payload };
      this.ws.send(JSON.stringify(frame));
      this.forwardedCount++;
    } catch {
      /* drop on serialization errors — relay is best-effort */
    }
  }

  private setState(s: RelayState): void {
    this.state = s;
    try {
      this.onStateChange(s);
    } catch {
      /* swallow listener errors */
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState({ kind: "connecting" });

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.cfg.url);
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : String(err));
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = 1000;
      const reg: RelayFrame = {
        type: "register",
        sessionName: this.cfg.sessionName,
        authToken: this.cfg.authToken,
        role: "host",
      };
      try {
        ws.send(JSON.stringify(reg));
      } catch {
        /* will surface via close */
      }
      this.setState({ kind: "live" });
      // keepalive every 25s
      this.keepaliveTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ type: "keepalive" } satisfies RelayFrame));
        } catch {
          /* ignore */
        }
      }, 25_000);
    });

    ws.on("message", (data) => {
      let frame: RelayFrame;
      try {
        frame = JSON.parse(data.toString()) as RelayFrame;
      } catch {
        return;
      }
      if (frame.type === "forward" && frame.direction === "rpc") {
        try {
          this.onRemoteRpc(frame.payload);
        } catch {
          /* swallow — never let remote msgs crash the relay loop */
        }
      } else if (frame.type === "error") {
        this.setState({ kind: "error", error: frame.error });
      }
      // ignore keepalive, register echoes
    });

    let downHandled = false;
    const onDown = (reason: string) => {
      if (downHandled) return;
      downHandled = true;
      if (this.keepaliveTimer) {
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
      }
      this.scheduleReconnect(reason);
    };

    ws.on("error", (err) => {
      onDown(err instanceof Error ? err.message : String(err));
    });
    ws.on("close", (code) => {
      onDown(`closed (${code})`);
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.setState({ kind: "error", error: reason });
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
