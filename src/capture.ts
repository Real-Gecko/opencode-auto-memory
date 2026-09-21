import type { AutoMemoryOptions } from "./config.ts";
import { dbg, dbgAwait } from "./logger.ts";
import { getMcp } from "./mcp.ts";
import { renderParts, type MessagePart } from "./render.ts";
import { clip } from "./render.ts";
import { commitSession, forgetSession, loadState } from "./state.ts";

interface SessionInfo {
  id: string;
  title?: string;
  parentID?: string;
}

interface ToolState {
  status?: string;
  title?: string;
  input?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string }>;
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
    if (item.type === "text" && item.text) {
      parts.push({ type: "text", text: item.text });
    } else if (item.type === "tool") {
      const state = item.state ?? {};
      parts.push({
        type: "tool",
        name: item.name,
        state: {
          status: state.status,
          title: state.title,
          input: state.input,
          content: state.content,
          error: state.error,
        },
      });
    }
  }
  return parts;
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
    const entry = loadState().sessions[sessionID];

    const session = await dbgAwait("session.get", client.session.get({ sessionID }));
    dbg(
      `session: ${JSON.stringify(
        session ? { id: session.id, title: session.title, parentID: session.parentID } : session,
      )}`,
    );
    if (session?.parentID) {
      dbg("skip: subagent session");
      return;
    }

    const messages = (await dbgAwait("session.context", client.session.context({ sessionID }))) ?? [];
    dbg(`messages: ${messages.length}`);

    let kbSessionID = entry?.kbSessionID;
    const logged = new Set(entry?.logged ?? []);
    const newMessages = messages.filter((msg) => !logged.has(msg.id) && isReady(msg));
    dbg(`newMessages: ${newMessages.length}`);
    if (newMessages.length === 0) {
      dbg("no new messages, return");
      return;
    }

    const sessionName = session?.title || sessionID;
    // Persist as we go, not once at the end: a timed-out log_message throws out
    // of the loop, and an unsaved kbSessionID means the next idle opens a second
    // KB session and re-logs everything into it.
    const persist = () =>
      commitSession(sessionID, { kbSessionID, logged: [...logged], name: sessionName });

    const server = await dbgAwait("getMcp", getMcp(options));
    if (kbSessionID === undefined) {
      // Spawning the MCP server can take a while; re-read in case another
      // process assigned this session an id since loadState().
      kbSessionID = loadState().sessions[sessionID]?.kbSessionID;
    }
    if (kbSessionID === undefined) {
      const text = await dbgAwait(
        "start_logging_session",
        server.callTool("start_logging_session", { name: sessionName }),
      );
      dbg(`start_logging_session => ${text}`);
      const match = text.match(/#(\d+)/);
      if (!match?.[1]) return;
      kbSessionID = Number(match[1]);
      persist();
    }
    dbg(`kbSessionID=${kbSessionID}`);

    for (const msg of newMessages) {
      const role = msg.type === "user" ? "user" : "agent";
      const content = renderParts(toParts(msg), options);
      if (!content.trim()) {
        logged.add(msg.id);
        persist();
        continue;
      }
      const payload: Record<string, unknown> = {
        role,
        content: clip(content.trim(), options.messageLimit),
        sessionId: kbSessionID,
      };
      let reply = await server.callTool("log_message", payload);

      if (reply.includes("already closed")) {
        dbg(`kbSessionID=${kbSessionID} was auto-closed, opening a replacement`);
        const startText = await server.callTool("start_logging_session", { name: sessionName });
        const match = startText.match(/#(\d+)/);
        if (!match?.[1]) {
          dbg(`could not reopen a session: ${startText.slice(0, 200)}`);
          break;
        }
        kbSessionID = Number(match[1]);
        payload.sessionId = kbSessionID;
        persist();
        reply = await server.callTool("log_message", payload);
      }

      if (reply.startsWith("❌")) {
        dbg(`log_message failed for ${msg.id}: ${reply}`);
        continue;
      }
      if (!reply.startsWith("📝")) {
        dbg(`log_message unexpected reply for ${msg.id}: ${reply.slice(0, 200)}`);
      }
      logged.add(msg.id);
      persist();
    }
    dbg(`logged ${logged.size} total`);

    persist();
    dbg("state saved");
  } catch (error) {
    dbg(`ERROR: ${(error as Error)?.message ?? error}`);
    dbg((error as Error)?.stack ?? "");
    console.error("[auto-memory] failed to log session:", (error as Error)?.message ?? error);
  }
}

export async function handleDeleted(sessionID: string, options: AutoMemoryOptions): Promise<void> {
  dbg(`handleDeleted sessionID=${sessionID}`);
  try {
    const entry = loadState().sessions[sessionID];
    if (entry?.kbSessionID === undefined) return;
    const server = await getMcp(options);
    await server.callTool("end_session", { sessionId: entry.kbSessionID });
    // Re-read after the await, for the reason commitSession explains.
    forgetSession(sessionID);
    dbg(`ended kbSessionID=${entry.kbSessionID}`);
  } catch (error) {
    dbg(`ERROR (deleted): ${(error as Error)?.message ?? error}`);
  }
}

/**
 * Drain sessions this process touched. A one-shot `opencode run` exits before
 * the idle indexing finishes, so without this its transcript waits for the next
 * time the same session goes idle -- which for a throwaway run never happens.
 */
export async function flushSessions(
  client: CaptureClient,
  sessionIDs: Iterable<string>,
  options: AutoMemoryOptions,
): Promise<void> {
  for (const sessionID of sessionIDs) {
    await oncePerSession(sessionID, () => handleIdle(client, sessionID, options));
  }
}
