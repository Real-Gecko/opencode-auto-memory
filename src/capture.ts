import type { AutoMemoryOptions } from "./config.ts";
import { forgetSessionIndex, indexedMessageIDs, indexMessage, inTransaction, isIndexed } from "./db.ts";
import { dbg, dbgAwait } from "./logger.ts";
import { mainSessionMessages, readMessage } from "./opencode-db.ts";
import { clip, renderParts, type MessagePart } from "./render.ts";

interface SessionInfo {
  id: string;
  title?: string;
  parentID?: string;
}

interface ToolState {
  status?: string;
  title?: string;
  input?: Record<string, unknown>;
  error?: string | { message?: string };
}

interface MessageContent {
  type?: string;
  text?: string;
  name?: string;
  state?: ToolState;
}

/**
 * Structural subset of the V2 SessionMessageInfo union this module needs.
 * Kept local so a change in an unrelated message type cannot break the build.
 */
export interface SessionMessage {
  id: string;
  type?: string;
  time?: { created?: number; completed?: number };
  text?: string;
  content?: MessageContent[];
}

/** The parts of the V2 plugin context this module needs. */
export interface CaptureClient {
  session: {
    get: (args: { sessionID: string }) => Promise<SessionInfo | undefined>;
    context: (args: { sessionID: string }) => Promise<SessionMessage[] | undefined>;
  };
}

/**
 * A compaction summary or a still-streaming assistant message is not ready.
 * An incomplete assistant message is simply picked up by the next idle, so
 * nothing is lost.
 */
function isReady(msg: SessionMessage): boolean {
  if (msg.type === "compaction") return false;
  if (msg.type !== "assistant") return true;
  return typeof msg.time?.completed === "number";
}

/** Map a V2 message to the part list renderParts understands. */
function toParts(msg: SessionMessage): MessagePart[] {
  if (msg.type === "user") {
    return msg.text ? [{ type: "text", text: msg.text }] : [];
  }
  if (msg.type !== "assistant") return [];
  const parts: MessagePart[] = [];
  for (const item of msg.content ?? []) {
    if ((item.type === "text" || item.type === "reasoning") && item.text) {
      parts.push({ type: item.type, text: item.text });
    } else if (item.type === "tool") {
      const state = item.state ?? {};
      parts.push({
        type: "tool",
        name: item.name,
        state: { status: state.status, title: state.title, input: state.input, error: state.error },
      });
    }
  }
  return parts;
}

export function roleOf(msg: SessionMessage): string {
  return msg.type === "user" ? "user" : "agent";
}

export function renderMessage(msg: SessionMessage, options: AutoMemoryOptions): string {
  return clip(renderParts(toParts(msg), options).trim(), options.messageLimit);
}

const inFlight = new Map<string, Promise<void>>();

export async function oncePerSession(sessionID: string, task: () => Promise<void>): Promise<void> {
  const existing = inFlight.get(sessionID);
  if (existing) return existing;
  const run = (async () => {
    try {
      await task();
    } finally {
      inFlight.delete(sessionID);
    }
  })();
  inFlight.set(sessionID, run);
  await run;
}

export async function handleIdle(
  client: CaptureClient,
  sessionID: string,
  options: AutoMemoryOptions,
): Promise<void> {
  dbg(`handleIdle start sessionID=${sessionID}`);
  try {
    if (!options.captureTranscripts) return;

    const session = await dbgAwait("session.get", client.session.get({ sessionID }));
    if (session?.parentID) {
      dbg("skip: subagent session");
      return;
    }

    const messages = (await dbgAwait("session.context", client.session.context({ sessionID }))) ?? [];
    const newMessages = messages.filter((msg) => isReady(msg) && !isIndexed(msg.id));
    dbg(`messages: ${messages.length}, new: ${newMessages.length}`);

    for (const msg of newMessages) {
      indexMessage(
        { messageID: msg.id, sessionID, role: roleOf(msg), time: msg.time?.created },
        renderMessage(msg, options),
      );
    }
  } catch (error) {
    dbg(`ERROR: ${(error as Error)?.message ?? error}`);
    dbg((error as Error)?.stack ?? "");
    console.error("[auto-memory] failed to index session:", (error as Error)?.message ?? error);
  }
}

export async function handleDeleted(sessionID: string): Promise<void> {
  dbg(`handleDeleted sessionID=${sessionID}`);
  try {
    forgetSessionIndex(sessionID);
  } catch (error) {
    dbg(`ERROR (deleted): ${(error as Error)?.message ?? error}`);
  }
}

const BACKFILL_BATCH = 100;
// Each plugin location loads its own copy of this module, so the in-flight run
// is kept on globalThis to be shared by all of them.
const BACKFILL_KEY = Symbol.for("opencode-auto-memory.backfill");
const shared = globalThis as { [BACKFILL_KEY]?: Promise<void> };

/**
 * Index every message opencode has stored that the index lacks, so history from
 * before the plugin (or from while it was not running) is searchable. Plugin
 * instances that start together share one run, and it works in batches that
 * yield, so the server is not blocked.
 */
export function backfill(options: AutoMemoryOptions): Promise<void> {
  shared[BACKFILL_KEY] ??= indexStoredHistory(options).finally(() => {
    delete shared[BACKFILL_KEY];
  });
  return shared[BACKFILL_KEY];
}

async function indexStoredHistory(options: AutoMemoryOptions): Promise<void> {
  try {
    const indexed = indexedMessageIDs();
    const pending = mainSessionMessages().filter((row) => !indexed.has(row.id));
    dbg(`backfill: ${pending.length} message(s)`);
    for (let start = 0; start < pending.length; start += BACKFILL_BATCH) {
      inTransaction(() => {
        for (const { id, sessionID } of pending.slice(start, start + BACKFILL_BATCH)) {
          const msg = readMessage(sessionID, id);
          if (!msg || !isReady(msg)) continue;
          indexMessage(
            { messageID: id, sessionID, role: roleOf(msg), time: msg.time?.created },
            renderMessage(msg, options),
          );
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    dbg("backfill: done");
  } catch (error) {
    dbg(`backfill ERROR: ${(error as Error)?.message ?? error}`);
  }
}
