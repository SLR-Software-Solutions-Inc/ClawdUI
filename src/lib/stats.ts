import { writable, get } from "svelte/store";

/**
 * Per-turn token usage breakdown surfaced by the Claude Agent SDK
 * (mirrors the `usage` field on assistant messages and the `result` event).
 */
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
};

/** Stats for the most recent turn (cleared at the start of each new turn). */
export type TurnStats = {
  /** Wall-clock ms when the user message was sent. */
  sentAt: number | null;
  /** Wall-clock ms when the first assistant token arrived. */
  firstTokenAt: number | null;
  /** Wall-clock ms when the SDK `result` event arrived. */
  endAt: number | null;
  /** Time-to-first-token (ms). */
  ttfMs: number | null;
  /** End-to-end latency request → result (ms). */
  e2eMs: number | null;
  /** Per-turn token usage (cumulative across all assistant messages in this turn). */
  usage: Usage;
  /**
   * Per-message usage from the MOST RECENT assistant message in this turn.
   *
   * Why this is separate from `usage` above: a single turn can contain N
   * assistant messages (one per agent-loop step / tool call). Each message's
   * `usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
   * is the FULL prompt size at that step — not a delta. Summing them across
   * N steps overcounts the real context footprint by ~Nx.
   *
   * Use this field — NOT `usage` — to compute the context-window utilization
   * gauge. `usage` remains for cumulative-per-turn cost / token displays.
   */
  lastMessageUsage: Usage;
  /** Per-turn cost (USD). */
  costUsd: number;
  /** True while waiting for the first assistant token. */
  streaming: boolean;
};

/** Cumulative stats across the lifetime of the session. */
export type SessionStats = {
  /** When the session was started. */
  startedAt: number | null;
  /** Cumulative token usage. */
  usage: Usage;
  /** Cumulative cost (USD). */
  costUsd: number;
  /** Number of completed turns. */
  turns: number;
};

export type Stats = {
  turn: TurnStats;
  session: SessionStats;
};

const EMPTY_TURN: TurnStats = {
  sentAt: null,
  firstTokenAt: null,
  endAt: null,
  ttfMs: null,
  e2eMs: null,
  usage: { ...ZERO_USAGE },
  lastMessageUsage: { ...ZERO_USAGE },
  costUsd: 0,
  streaming: false,
};

const EMPTY_SESSION: SessionStats = {
  startedAt: null,
  usage: { ...ZERO_USAGE },
  costUsd: 0,
  turns: 0,
};

export const stats = writable<Stats>({
  turn: { ...EMPTY_TURN, usage: { ...ZERO_USAGE }, lastMessageUsage: { ...ZERO_USAGE } },
  session: { ...EMPTY_SESSION, usage: { ...ZERO_USAGE } },
});

export function getStats(): Stats {
  return get(stats);
}

/** Reset everything. Call when a fresh session starts. */
export function resetSessionStats(now: number = Date.now()): void {
  stats.set({
    turn: { ...EMPTY_TURN, usage: { ...ZERO_USAGE }, lastMessageUsage: { ...ZERO_USAGE } },
    session: { ...EMPTY_SESSION, usage: { ...ZERO_USAGE }, startedAt: now },
  });
}

/** Mark the session as ended (preserve stats but stop tracking). */
export function endSessionStats(): void {
  stats.update((s) => ({
    ...s,
    turn: { ...s.turn, streaming: false },
  }));
}

/** Record that a user prompt was just sent. Starts a new turn. */
export function markTurnSent(now: number = Date.now()): void {
  stats.update((s) => ({
    ...s,
    turn: {
      sentAt: now,
      firstTokenAt: null,
      endAt: null,
      ttfMs: null,
      e2eMs: null,
      usage: { ...ZERO_USAGE },
      // Preserve lastMessageUsage across turns — it reflects the current
      // context-window footprint until the next assistant message updates it.
      // Resetting here would briefly show 0% in the pill at turn-start.
      lastMessageUsage: s.turn.lastMessageUsage,
      costUsd: 0,
      streaming: true,
    },
  }));
}

/** Record arrival of the first assistant token for the current turn. */
export function markFirstAssistantToken(now: number = Date.now()): void {
  stats.update((s) => {
    if (s.turn.firstTokenAt != null || s.turn.sentAt == null) return s;
    return {
      ...s,
      turn: {
        ...s.turn,
        firstTokenAt: now,
        ttfMs: now - s.turn.sentAt,
      },
    };
  });
}

/**
 * Add per-assistant-message usage to the current turn AND the session totals.
 * Called for each `assistant` event that carries a `usage` block.
 */
export function addUsage(u: Partial<Usage> | undefined | null): void {
  if (!u) return;
  const delta: Usage = {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheCreation: u.cacheCreation ?? 0,
  };
  stats.update((s) => ({
    turn: {
      ...s.turn,
      usage: addUsages(s.turn.usage, delta),
      // OVERWRITE (not sum) — each assistant message's usage represents the
      // FULL prompt size at that step, not a delta. The latest message is
      // the most accurate snapshot of current context-window utilization.
      lastMessageUsage: delta,
    },
    session: {
      ...s.session,
      usage: addUsages(s.session.usage, delta),
    },
  }));
}

/**
 * Final settle for the turn — called when SDK `result` arrives.
 * `totalCostUsd` is the SDK's authoritative per-result cost; we treat it as
 * the cost of THIS turn and add it to the session total.
 */
export function settleTurn(
  totalCostUsd: number | undefined | null,
  now: number = Date.now(),
): void {
  stats.update((s) => {
    const cost = typeof totalCostUsd === "number" ? totalCostUsd : 0;
    const e2e = s.turn.sentAt != null ? now - s.turn.sentAt : null;
    return {
      turn: {
        ...s.turn,
        endAt: now,
        e2eMs: e2e,
        costUsd: cost,
        streaming: false,
      },
      session: {
        ...s.session,
        costUsd: s.session.costUsd + cost,
        turns: s.session.turns + 1,
      },
    };
  });
}

function addUsages(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

/**
 * Normalise the SDK's `usage` shape (snake_case) into our `Usage` shape.
 * Accepts the variants used by both `assistant` messages and `result` events.
 */
export function normalizeSdkUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    input: num(r.input_tokens),
    output: num(r.output_tokens),
    cacheRead: num(r.cache_read_input_tokens),
    cacheCreation: num(r.cache_creation_input_tokens),
  };
}
