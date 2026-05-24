/**
 * Runtime-fetched model context window cache.
 *
 * Source of truth: the Claude Agent SDK itself. Every `result` event the SDK
 * emits carries `modelUsage: Record<modelId, ModelUsage>` where each
 * `ModelUsage` includes `contextWindow` and `maxOutputTokens` — the actual
 * limits the SDK is enforcing for that model right now. We harvest those
 * values as they arrive, cache them in localStorage with a 24h TTL, and
 * expose a reactive store so the compaction pill + auto-compact thresholds
 * update the moment the real limit is known.
 *
 * Why not hit `/v1/models`? The SDK's `ModelInfo` (returned from
 * `supportedModels()`) does NOT include `contextWindow` — only `ModelUsage`
 * does. Harvesting from the live event stream is both more accurate (it
 * reflects the limit the SDK is actually applying, including any beta
 * extensions like 1M context) and zero extra round-trips.
 *
 * Hardcoded fallback in `FALLBACK_TABLE` is last resort only — used until
 * the first `result` event lands for a given model. Never the source of
 * truth.
 */

import { writable, get } from "svelte/store";

const STORAGE_KEY = "clawdui.model_context_windows.v1";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * FALLBACK ONLY — runtime SDK `modelUsage.contextWindow` is the source of
 * truth. These values are used until the first turn completes for a given
 * model id. Match on bare id (vendor prefix stripped).
 */
const FALLBACK_TABLE: Record<string, number> = {
  "claude-opus-4-7": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
};
const FALLBACK_DEFAULT = 200_000;

type CacheEntry = {
  /** Bare model id (vendor prefix stripped). */
  model: string;
  /** Real context window in tokens (from SDK `ModelUsage.contextWindow`). */
  contextWindow: number;
  /** Wall-clock ms when harvested. */
  fetchedAt: number;
};

type CacheMap = Record<string, CacheEntry>;

/** Reactive in-memory mirror of the on-disk cache. Updates trigger Svelte. */
export const modelContextWindows = writable<CacheMap>({});

function bareId(modelId: string): string {
  return modelId.includes("/") ? modelId.split("/").pop()! : modelId;
}

function loadFromStorage(): CacheMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: CacheMap = {};
    const now = Date.now();
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const e = v as Partial<CacheEntry>;
      if (
        typeof e.contextWindow === "number" &&
        Number.isFinite(e.contextWindow) &&
        e.contextWindow > 0 &&
        typeof e.fetchedAt === "number" &&
        now - e.fetchedAt < TTL_MS
      ) {
        out[k] = {
          model: k,
          contextWindow: e.contextWindow,
          fetchedAt: e.fetchedAt,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persist(map: CacheMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota exceeded or storage disabled — silently skip. Fallback still works.
  }
}

let hydrated = false;
/** Load any prior cache from localStorage. Call once on app boot. */
export function hydrateModelContextWindows(): void {
  if (hydrated) return;
  hydrated = true;
  const loaded = loadFromStorage();
  modelContextWindows.set(loaded);
}

/**
 * Harvest `contextWindow` values from the SDK `result` event's `modelUsage`
 * record. Called from App.svelte's `t === "result"` branch.
 *
 * Idempotent and cheap — only writes when the value differs from what's
 * already cached (avoids needless localStorage churn).
 */
export function recordModelContextWindows(
  modelUsage: unknown,
): void {
  if (!modelUsage || typeof modelUsage !== "object") return;
  let dirty = false;
  const next = { ...get(modelContextWindows) };
  for (const [rawId, usage] of Object.entries(
    modelUsage as Record<string, unknown>,
  )) {
    if (!usage || typeof usage !== "object") continue;
    const cw = (usage as Record<string, unknown>).contextWindow;
    if (typeof cw !== "number" || !Number.isFinite(cw) || cw <= 0) continue;
    const id = bareId(rawId);
    const prior = next[id];
    if (prior && prior.contextWindow === cw) {
      // Refresh fetchedAt to extend TTL even if unchanged.
      next[id] = { ...prior, fetchedAt: Date.now() };
      dirty = true;
      continue;
    }
    next[id] = { model: id, contextWindow: cw, fetchedAt: Date.now() };
    dirty = true;
  }
  if (dirty) {
    modelContextWindows.set(next);
    persist(next);
  }
}

/**
 * Resolve the context window for a model id. Order:
 *   1. Live in-memory cache (populated from SDK `modelUsage`)
 *   2. Hardcoded fallback table
 *   3. Generic 200K default
 *
 * Safe to call from a Svelte reactive `$:` block — subscribe to
 * `modelContextWindows` to re-run when the cache updates.
 */
export function contextWindowFor(modelId: string | undefined): number {
  if (!modelId) return FALLBACK_DEFAULT;
  const id = bareId(modelId);
  const cached = get(modelContextWindows)[id];
  if (cached) return cached.contextWindow;
  return FALLBACK_TABLE[id] ?? FALLBACK_DEFAULT;
}
