import type { ChatMessage } from "./types";
import { writable, get, type Writable } from "svelte/store";

export type AgentStatus = "running" | "done" | "error";

/**
 * "rpc" — entry created via the sidecar's spawn_child RPC path
 *         (ensureChildAgent in App.svelte after a child_started event).
 * "sdk" — synthetic entry created when the master session emits a
 *         `tool_use` block for the SDK's built-in Agent / Task tool.
 *         No sidecar child session exists for these.
 */
export type AgentSource = "rpc" | "sdk";

export type Agent = {
  id: string;
  parentId: string | null;
  label: string;
  status: AgentStatus;
  transcript: ChatMessage[];
  startedAt: number;
  endedAt?: number;
  source?: AgentSource;
};

// Single reactive container — wrapping in an object with getters/setters
// is the canonical Svelte 5 pattern for cross-module reactive state. The
// previous "module-level let + function getter" pattern relies on the
// caller's $derived/$effect capturing the read at exactly the right
// moment; under HMR or when a Webview reloads modules, that capture can
// drop silently (the visual bug observed: clicking the drawer strip
// flips the $state but the consumer's $derived never recomputes because
// no signal dep was registered for the primitive read across the module
// boundary). Putting the state on a $state-proxied object means every
// `_state.drawerOpen` read goes through the proxy and is always tracked.
//
// Drawer state is exported as Svelte writable stores (NOT $state runes).
// We tried $state proxies twice and the bundled WebKit build still failed
// to update the body conditional on toggle — module-scoped runes state
// can drop reactive deps across module boundaries under certain build
// configurations. Writable stores are battle-tested, work in legacy AND
// runes components, and reactivity is guaranteed via subscriptions.
export const drawerOpen: Writable<boolean> = writable(false);
export const drawerActiveId: Writable<string | null> = writable(null);

const _state = $state<{
  agents: Agent[];
  activeAgentId: string;
}>({
  agents: [
    {
      id: "master",
      parentId: null,
      label: "Main",
      status: "running",
      transcript: [],
      startedAt: Date.now(),
    },
  ],
  activeAgentId: "master",
});

/**
 * tool_use_ids of spawn-child invocations seen in the master transcript,
 * mapped to the resulting child session id (when known). The MessageBlock
 * component checks this to suppress the corresponding tool_result blob in
 * master view and show a one-line "returned" chip instead.
 */
const spawnToolUseIds = $state<Record<string, string | undefined>>({});

export function registerSpawnToolUse(toolUseId: string, childId?: string): void {
  spawnToolUseIds[toolUseId] = childId;
}
export function isSpawnToolUseId(toolUseId: string | undefined): boolean {
  if (!toolUseId) return false;
  return Object.prototype.hasOwnProperty.call(spawnToolUseIds, toolUseId);
}
export function getSpawnChildId(toolUseId: string | undefined): string | undefined {
  if (!toolUseId) return undefined;
  return spawnToolUseIds[toolUseId];
}

/**
 * Synthetic SDK-tool agents: tool_use_id IS the agent id.
 * Registered when the master session emits an Agent / Task tool_use,
 * status flipped when the matching tool_result arrives.
 */
function sdkLabelFromInput(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const desc =
    (typeof i.description === "string" && i.description) ||
    (typeof i.subagent_type === "string" && i.subagent_type) ||
    (typeof i.prompt === "string" && i.prompt) ||
    "sdk task";
  const oneLine = String(desc).replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? oneLine.slice(0, 59) + "…" : oneLine;
}

/**
 * Register a synthetic agent entry for an SDK Agent/Task tool_use in the
 * master session. The tool_use id is also the agent id, so the matching
 * tool_result can flip its status by id directly.
 *
 * Idempotent — repeated calls with the same id are no-ops.
 */
export function registerSdkAgentToolUse(
  toolUseId: string,
  toolName: string,
  input: unknown,
  parentId: string = "master",
): void {
  // Track in spawn map so MessageBlock keeps suppressing the tool_use /
  // tool_result blobs in the master view (existing behavior).
  if (!Object.prototype.hasOwnProperty.call(spawnToolUseIds, toolUseId)) {
    spawnToolUseIds[toolUseId] = undefined;
  }
  if (_state.agents.some((a) => a.id === toolUseId)) return;
  const label = sdkLabelFromInput(input);
  // Route through addAgent so the 0→1-child auto-open chokepoint fires
  // for SDK delegations too. Before this, the SDK path pushed straight
  // into _state.agents and then App.svelte called ensureChildAgent →
  // addAgent again — so by the time addAgent ran, the child was already
  // there, wasEmpty=false, auto-open silently skipped. Result: 20+
  // duplicate entries and drawer never popped.
  addAgent({
    id: toolUseId,
    parentId,
    label: label || toolName,
    source: "sdk",
  } as Omit<Agent, "transcript" | "status" | "startedAt"> & Partial<Agent>);
}

/** Flip a synthetic SDK agent's status when its tool_result arrives. */
export function completeSdkAgentToolUse(
  toolUseId: string,
  isError: boolean,
): boolean {
  const a = _state.agents.find((x) => x.id === toolUseId && x.source === "sdk");
  if (!a) return false;
  a.status = isError ? "error" : "done";
  a.endedAt = Date.now();
  return true;
}

export function getAgents(): Agent[] {
  return _state.agents;
}
export function getChildren(): Agent[] {
  return _state.agents.filter((a) => a.parentId === "master");
}
export function getActiveAgentId(): string {
  return _state.activeAgentId;
}
export function setActiveAgentId(id: string): void {
  _state.activeAgentId = id;
}
export function getDrawerActiveId(): string | null {
  return get(drawerActiveId);
}
export function setDrawerActiveId(id: string | null): void {
  drawerActiveId.set(id);
}
export function getDrawerOpen(): boolean {
  return get(drawerOpen);
}
// On-screen event log so users can SEE what's happening without opening
// the Web Inspector. AgentDrawer renders a small HUD that reads this.
export const drawerEventLog = writable<string[]>([]);
function pushDrawerEvent(msg: string): void {
  const stamp = new Date().toISOString().slice(11, 23);
  drawerEventLog.update((arr) => [...arr.slice(-9), `${stamp} ${msg}`]);
}

export function setDrawerOpen(v: boolean): void {
  pushDrawerEvent(`setDrawerOpen(${v})`);
  try {
    console.log("[DRAWER]", { setDrawerOpen: v });
  } catch {}
  drawerOpen.set(v);
}
export function pushMessage(agentId: string, msg: ChatMessage): void {
  const a = _state.agents.find((x) => x.id === agentId);
  if (a) a.transcript = [...a.transcript, msg];
}
export function setTranscript(agentId: string, transcript: ChatMessage[]): void {
  const a = _state.agents.find((x) => x.id === agentId);
  if (a) a.transcript = transcript;
}
export function getAgent(id: string): Agent | undefined {
  return _state.agents.find((x) => x.id === id);
}
export function addAgent(
  a: Omit<Agent, "transcript" | "status" | "startedAt"> & Partial<Agent>,
): void {
  // Single auto-open chokepoint. Both the SDK Agent/Task path
  // (registerSdkAgentToolUse → addAgent) and the sidecar spawn_child
  // path (ensureChildAgent → addAgent) flow through this primitive, so
  // wiring the 0→1-child drawer pop here covers both. Earlier the trigger
  // sat in ensureChildAgent only and SDK delegations silently bypassed it —
  // strip label updated, drawer stayed collapsed.
  // Idempotent: if an agent with this id already exists, skip the push.
  // Two paths can add the same child (SDK Agent/Task → registerSdkAgentToolUse
  // AND App.svelte → ensureChildAgent), so without this guard the agents
  // list doubles every SDK delegation.
  if (a.id && _state.agents.some((x) => x.id === a.id)) {
    pushDrawerEvent(`addAgent skip-dup id=${a.id.slice(0, 14)}`);
    return;
  }
  const wasEmpty =
    _state.agents.filter((x) => x.parentId === "master").length === 0;
  _state.agents = [
    ..._state.agents,
    { transcript: [], status: "running", startedAt: Date.now(), ...a } as Agent,
  ];
  pushDrawerEvent(
    `addAgent id=${a.id?.slice(0, 14) ?? "?"} parent=${a.parentId ?? "null"} wasEmpty=${wasEmpty}`,
  );
  if (a.parentId === "master") {
    drawerActiveId.set(a.id);
    if (wasEmpty) {
      pushDrawerEvent(`auto-open fired`);
      drawerOpen.set(true);
    }
  }
}
export function setAgentStatus(id: string, status: AgentStatus): void {
  const a = _state.agents.find((x) => x.id === id);
  if (a) {
    a.status = status;
    if (status !== "running") {
      a.endedAt = Date.now();
      // Settle any in-flight streaming flags so the drawer stops showing
      // STREAMING badges + cursor caret on a finished child.
      a.transcript = a.transcript.map((m) =>
        m.streaming ? { ...m, streaming: false } : m,
      );
    }
  }
}
/**
 * Subscribers (e.g. App.svelte / sidecar bridge) register a callback to
 * receive cancel requests for a given agent id. The Fleet View calls
 * requestCancel(id); backend wiring is the subscriber's concern.
 *
 * App.svelte forwards each id to the sidecar's `cancel_child` RPC which
 * interrupts the child's SDK query and ends its message queue. For SDK
 * Agent/Task entries (no dedicated sidecar session) the sidecar falls
 * back to interrupting master so the in-flight tool returns control.
 */
type CancelHandler = (id: string) => void;
const cancelHandlers: CancelHandler[] = [];
export function onAgentCancelRequested(h: CancelHandler): () => void {
  cancelHandlers.push(h);
  return () => {
    const i = cancelHandlers.indexOf(h);
    if (i >= 0) cancelHandlers.splice(i, 1);
  };
}
export function requestCancel(id: string): void {
  pushDrawerEvent(`requestCancel id=${id.slice(0, 14)}`);
  for (const h of cancelHandlers) {
    try {
      h(id);
    } catch (e) {
      console.error("[agents] cancel handler threw", e);
    }
  }
  // Optimistic local flip — backend may confirm via its own status update.
  const a = _state.agents.find((x) => x.id === id);
  if (a && a.status === "running") {
    a.status = "error";
    a.endedAt = Date.now();
    a.transcript = [
      ...a.transcript,
      {
        role: "system",
        blocks: [{ type: "text", text: "[cancelled by user]" }],
        timestamp: Date.now(),
      },
    ];
  }
}

/**
 * Per-agent token usage. Fed by the sidecar's `agent_tokens` event which
 * extracts input_tokens/output_tokens from each assistant/result record
 * and tags the delta with session_id. App.svelte's sidecar-event handler
 * calls updateAgentTokens() for every such delta.
 */
const _tokens = $state<Record<string, { input: number; output: number }>>({});
export function getAgentTokens(id: string): { input: number; output: number } {
  return _tokens[id] ?? { input: 0, output: 0 };
}
export function updateAgentTokens(
  id: string,
  delta: { input?: number; output?: number },
): void {
  const cur = _tokens[id] ?? { input: 0, output: 0 };
  _tokens[id] = {
    input: cur.input + (delta.input ?? 0),
    output: cur.output + (delta.output ?? 0),
  };
}

/** Children of a given parent id (any depth — caller recurses). */
export function getChildrenOf(parentId: string | null): Agent[] {
  return _state.agents.filter((a) => a.parentId === parentId);
}

export function resetAgents(): void {
  pushDrawerEvent("resetAgents() — closing drawer");
  _state.agents = [
    {
      id: "master",
      parentId: null,
      label: "Main",
      status: "running",
      transcript: [],
      startedAt: Date.now(),
    },
  ];
  _state.activeAgentId = "master";
  drawerActiveId.set(null);
  drawerOpen.set(false);
  for (const k of Object.keys(spawnToolUseIds)) delete spawnToolUseIds[k];
  for (const k of Object.keys(_tokens)) delete _tokens[k];
}
