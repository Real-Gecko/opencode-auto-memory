import { basename, join } from "node:path";
import { homedir } from "node:os";

/**
 * Each path is resolved per call and can be redirected with an environment
 * variable: tests must be able to point them somewhere harmless without relying
 * on $HOME, which bun resolves once at startup and does not re-read.
 */
export function dbPath(): string {
  return (
    process.env.AUTO_MEMORY_DB_PATH ??
    join(homedir(), ".local", "share", "opencode-auto-memory", "memory.db")
  );
}

export function debugPath(): string {
  return (
    process.env.AUTO_MEMORY_DEBUG_PATH ??
    join(homedir(), ".config", "opencode", "auto-memory-debug.log")
  );
}

export interface AutoMemoryOptions {
  /** Index session messages for `session_search`. Recall and the save reminder do not depend on it. */
  captureTranscripts: boolean;
  /** Add a short how-to-use-memory section to the system prompt. */
  memoryGuide: boolean;
  /** Max characters indexed per message. */
  messageLimit: number;
  /** Max characters of a tool call's JSON input. */
  toolInputLimit: number;
  /** Max characters of a failed tool call's error reason. */
  toolErrorLimit: number;
  /** Prepend relevant notes to the first message of a session. */
  injectContext: boolean;
  /** Max entries listed per injected section. */
  maxInjectEntries: number;
  /** Max characters of each injected entry's excerpt. */
  injectExcerptChars: number;
  /** Remind the agent to save when the user says "remember this". */
  keywordNudge: boolean;
  /** Extra regex sources appended to the built-in save-intent patterns. */
  keywordPatterns: string[];
  /**
   * Best-effort redaction of obviously secret values before indexing. Only values
   * sitting next to a secret-like name (`token`, `password`, `api_key`, ...),
   * bearer tokens, JWTs and private key blocks are redacted; unqualified
   * high-entropy strings are left alone to avoid destroying legit memory.
   */
  autoRedact: boolean;
  /** Rotate the debug log past this size. */
  debugMaxBytes: number;
}

export const DEFAULTS: AutoMemoryOptions = {
  captureTranscripts: true,
  memoryGuide: true,
  messageLimit: 32_000,
  toolInputLimit: 1_000,
  toolErrorLimit: 200,
  injectContext: true,
  maxInjectEntries: 5,
  injectExcerptChars: 220,
  keywordNudge: true,
  keywordPatterns: [],
  autoRedact: true,
  debugMaxBytes: 1024 * 1024,
};

const NUMBER_KEYS = [
  "messageLimit",
  "toolInputLimit",
  "toolErrorLimit",
  "maxInjectEntries",
  "injectExcerptChars",
  "debugMaxBytes",
] as const satisfies ReadonlyArray<keyof AutoMemoryOptions>;

const BOOLEAN_KEYS = [
  "captureTranscripts",
  "memoryGuide",
  "injectContext",
  "keywordNudge",
  "autoRedact",
] as const satisfies ReadonlyArray<keyof AutoMemoryOptions>;

/**
 * Merge options passed through the config's `["opencode-auto-memory", {...}]`
 * tuple form. Unknown keys and wrong types are ignored rather than thrown: a
 * typo in the config should not stop opencode from starting.
 */
export function resolveOptions(options?: Record<string, unknown>): AutoMemoryOptions {
  const resolved: AutoMemoryOptions = { ...DEFAULTS };
  if (!options) return resolved;

  for (const key of NUMBER_KEYS) {
    const value = options[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      resolved[key] = value;
    }
  }
  for (const key of BOOLEAN_KEYS) {
    const value = options[key];
    if (typeof value === "boolean") resolved[key] = value;
  }
  if (Array.isArray(options.keywordPatterns)) {
    resolved.keywordPatterns = options.keywordPatterns.filter(
      (pattern): pattern is string => typeof pattern === "string" && isValidRegex(pattern),
    );
  }
  return resolved;
}

function isValidRegex(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the directory whose name identifies the project. `opencode run` outside a
 * repository hands the plugin `worktree: "/"` or an empty string, and basename of
 * either is useless, so fall through to the next candidate.
 */
export function projectRootFrom(
  worktree?: string,
  directory?: string,
  cwd: string = process.cwd(),
): string {
  for (const candidate of [worktree, directory, cwd]) {
    if (candidate && basename(candidate)) return candidate;
  }
  return cwd;
}
