import { basename, join } from "node:path";
import { homedir } from "node:os";

/**
 * Default paths match the pre-package versions of this plugin, so existing state
 * carries over. Each is resolved per call and can be redirected with an
 * environment variable: tests must be able to point them somewhere harmless
 * without relying on $HOME, which bun resolves once at startup and does not
 * re-read.
 */
export function statePath(): string {
  return (
    process.env.AUTO_MEMORY_STATE_PATH ??
    join(homedir(), ".config", "opencode", "auto-memory.json")
  );
}

export function debugPath(): string {
  return (
    process.env.AUTO_MEMORY_DEBUG_PATH ??
    join(homedir(), ".config", "opencode", "auto-memory-debug.log")
  );
}

/**
 * fastembed caches its ~128MB ONNX model in ./local_cache, relative to the
 * server's cwd, so an unpinned cwd leaves a copy in every directory opencode
 * was started from.
 */
export function serverCwd(): string {
  return (
    process.env.AUTO_MEMORY_SERVER_CWD ??
    join(homedir(), ".cache", "opencode-personal-knowledge")
  );
}

export interface AutoMemoryOptions {
  /** Command that starts the personal-knowledge MCP server. */
  serverCommand: string;
  /**
   * Per-request MCP timeout. A cold start loads the embedding model before
   * answering, and log_message embeds the whole message; 30s was not enough.
   */
  requestTimeoutMs: number;
  /** Max characters stored per message. */
  messageLimit: number;
  /** Max characters of a tool call's JSON input. */
  toolInputLimit: number;
  /** Max characters of a failed tool call's error reason. */
  toolErrorLimit: number;
  /**
   * Store tool output too. Off by default: output was 79% of the store and is
   * almost never what a later search is looking for.
   */
  captureToolOutput: boolean;
  /** Max characters of tool output when captureToolOutput is on. */
  toolOutputLimit: number;
  /** Prepend relevant knowledge-base entries to the first message of a session. */
  injectContext: boolean;
  /**
   * Also run a semantic search for the first message. Keyword search hits sqlite
   * directly; semantic search waits on the embedding model and shares its index
   * with logged transcripts, so it is the noisier of the two.
   */
  injectSemantic: boolean;
  /** Give up on injection after this long so a cold model never stalls a turn. */
  injectTimeoutMs: number;
  /** Max entries listed per injected section. */
  maxInjectEntries: number;
  /** Max characters of each injected entry's excerpt. */
  injectExcerptChars: number;
  /** Remind the agent to save when the user says "remember this". */
  keywordNudge: boolean;
  /** Extra regex sources appended to the built-in save-intent patterns. */
  keywordPatterns: string[];
  /** Rotate the debug log past this size. */
  debugMaxBytes: number;
}

export const DEFAULTS: AutoMemoryOptions = {
  serverCommand: "opencode-personal-knowledge",
  requestTimeoutMs: 120_000,
  messageLimit: 32_000,
  toolInputLimit: 1_000,
  toolErrorLimit: 200,
  captureToolOutput: false,
  toolOutputLimit: 2_000,
  injectContext: true,
  injectSemantic: true,
  injectTimeoutMs: 5_000,
  maxInjectEntries: 5,
  injectExcerptChars: 220,
  keywordNudge: true,
  keywordPatterns: [],
  debugMaxBytes: 1024 * 1024,
};

const NUMBER_KEYS = [
  "requestTimeoutMs",
  "messageLimit",
  "toolInputLimit",
  "toolErrorLimit",
  "toolOutputLimit",
  "injectTimeoutMs",
  "maxInjectEntries",
  "injectExcerptChars",
  "debugMaxBytes",
] as const satisfies ReadonlyArray<keyof AutoMemoryOptions>;

const BOOLEAN_KEYS = [
  "captureToolOutput",
  "injectContext",
  "injectSemantic",
  "keywordNudge",
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
  if (typeof options.serverCommand === "string" && options.serverCommand.trim()) {
    resolved.serverCommand = options.serverCommand.trim();
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
