import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { statePath } from "./config.ts";

export interface SessionState {
  kbSessionID?: number;
  logged: string[];
  name?: string;
}

export interface AutoMemoryState {
  sessions: Record<string, SessionState>;
}

export function loadState(): AutoMemoryState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as AutoMemoryState;
    if (!parsed || typeof parsed !== "object" || typeof parsed.sessions !== "object") {
      return { sessions: {} };
    }
    return parsed;
  } catch {
    return { sessions: {} };
  }
}

export function saveState(state: AutoMemoryState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  // Write through a temp file: a torn state file reads back as an empty one,
  // and an empty one makes every session re-log its whole transcript.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/**
 * handleIdle loads state, then awaits an MCP spawn and one log_message per
 * message before saving, so the file can be seconds or minutes stale by then.
 * Overwriting it wholesale drops entries another opencode process wrote in that
 * window, and a session that loses its `logged` list re-logs everything into a
 * fresh KB session on the next idle -- the origin of the duplicate "Greeting"
 * sessions. Re-read and merge instead of overwriting.
 */
export function commitSession(sessionID: string, entry: SessionState): void {
  const state = loadState();
  const previous = state.sessions[sessionID];
  const logged = new Set([...(previous?.logged ?? []), ...entry.logged]);
  state.sessions[sessionID] = { ...entry, logged: [...logged] };
  saveState(state);
}

export function forgetSession(sessionID: string): void {
  const state = loadState();
  delete state.sessions[sessionID];
  saveState(state);
}
