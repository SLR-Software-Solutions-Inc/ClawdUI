import { writable, get } from "svelte/store";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { safeInvoke, safeListen } from "./safeInvoke";

export type Skill = {
  id: string;
  source: string;
  name: string;
  description: string;
  plugin?: string;
  path: string;
};

export const skills = writable<Skill[]>([]);
export const skillsLoading = writable<boolean>(false);

let unlistenEvent: UnlistenFn | null = null;
const pendingResolvers = new Map<string, (skills: Skill[]) => void>();
const pendingRejecters = new Map<string, (err: string) => void>();

function ensureListener(): Promise<void> {
  if (unlistenEvent) return Promise.resolve();
  return safeListen<any>("sidecar-event", (e) => {
    const ev = e.payload;
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "result" && pendingResolvers.has(ev.id)) {
      const resolve = pendingResolvers.get(ev.id)!;
      pendingResolvers.delete(ev.id);
      pendingRejecters.delete(ev.id);
      resolve(Array.isArray(ev.value) ? (ev.value as Skill[]) : []);
    } else if (ev.type === "error" && pendingRejecters.has(ev.id)) {
      const reject = pendingRejecters.get(ev.id)!;
      pendingResolvers.delete(ev.id);
      pendingRejecters.delete(ev.id);
      reject(ev.error ?? "unknown error");
    }
  }).then((fn) => {
    unlistenEvent = fn;
  });
}

function uuid(): string {
  return crypto.randomUUID();
}

export async function refreshSkills(
  pluginDirs: string[] = [],
  cwd?: string,
): Promise<Skill[]> {
  await ensureListener();
  skillsLoading.set(true);
  const id = uuid();
  const promise = new Promise<Skill[]>((resolve, reject) => {
    pendingResolvers.set(id, resolve);
    pendingRejecters.set(id, reject);
    setTimeout(() => {
      if (pendingResolvers.has(id)) {
        pendingResolvers.delete(id);
        pendingRejecters.delete(id);
        reject("list_skills timeout");
      }
    }, 5000);
  });
  try {
    const res = await safeInvoke("send_to_sidecar", {
      payload: JSON.stringify({ id, type: "list_skills", pluginDirs, cwd }),
    });
    if (res === null) {
      // Browser-preview: sidecar event will never fire — short-circuit.
      pendingResolvers.delete(id);
      pendingRejecters.delete(id);
      return get(skills);
    }
    const list = await promise;
    skills.set(list);
    return list;
  } catch (err) {
    console.error("[skills] refresh failed", err);
    return get(skills);
  } finally {
    skillsLoading.set(false);
  }
}

/** Fuzzy match: every char of query appears in id/name/description in order. */
export function fuzzyMatch(query: string, skill: Skill): number | null {
  const q = query.toLowerCase();
  if (!q) return 0;
  const id = skill.id.toLowerCase();
  const name = skill.name.toLowerCase();
  const desc = skill.description.toLowerCase();

  // strong: id starts with query
  if (id.startsWith(q)) return 1000 - id.length;
  if (name.startsWith(q)) return 900 - name.length;
  // contiguous substring
  if (id.includes(q)) return 800 - id.indexOf(q);
  if (name.includes(q)) return 700 - name.indexOf(q);
  // subsequence in id
  let i = 0;
  for (const c of id) {
    if (c === q[i]) i++;
    if (i === q.length) return 500 - id.length;
  }
  // last resort: description contains
  if (desc.includes(q)) return 100;
  return null;
}

export function filterSkills(query: string, list: Skill[]): Skill[] {
  if (!query) return list;
  const scored = list
    .map((s) => ({ s, score: fuzzyMatch(query, s) }))
    .filter((x): x is { s: Skill; score: number } => x.score !== null);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.s);
}
