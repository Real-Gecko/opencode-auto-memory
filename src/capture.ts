import type { AutoMemoryOptions } from "./config.ts";
import { dbg, dbgAwait } from "./logger.ts";
import { getMcp } from "./mcp.ts";
import { renderParts, type MessagePart } from "./render.ts";
import { clip } from "./render.ts";
import { commitSession, forgetSession, loadState } from "./state.ts";

interface MessageInfo {
  id: string;
  role: string;
  summary?: boolean;
  time?: { created?: number; completed?: number };
}

interface SessionMessage {
  info: MessageInfo;
  parts?: MessagePart[];
}

interface SessionInfo {
  id: string;
  title?: string;
  parentID?: string;
}

/** The parts of the opencode client this module needs. */
export interface CaptureClient {
  session: {
    get: (args: { path: { id: string } }) => Promise<{ data?: SessionInfo } | undefined>;
    messages: (args: { path: { id: string } }) => Promise<{ data?: SessionMessage[] } | undefined>;
  };
}

/**
 * An assistant message without a completion timestamp is still streaming. Left
 * unlogged it is simply picked up by the next idle, so nothing is lost.
 */
function isReady(info: MessageInfo): boolean {
  if (info.summary === true) return false;
  if (info.role !== "assistant") return true;
  return typeof info.time?.completed === "number";
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

    const sessionRes = await dbgAwait("session.get", client.session.get({ path: { id: sessionID } }));
    const session = sessionRes?.data;
    dbg(
      `session: ${JSON.stringify(
        session ? { id: session.id, title: session.title, parentID: session.parentID } : sessionRes,
      )}`,
    );
    if (session?.parentID) {
      dbg("skip: subagent session");
      return;
    }

    const messagesRes = await dbgAwait(
      "session.messages",
      client.session.messages({ path: { id: sessionID } }),
    );
    const messages = messagesRes?.data ?? [];
    dbg(`messages: ${messages.length}`);

    let kbSessionID = entry?.kbSessionID;
    const logged = new Set(entry?.logged ?? []);
    const newMessages = messages.filter((msg) => !logged.has(msg.info.id) && isReady(msg.info));
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
      const role = msg.info.role === "user" ? "user" : "agent";
      const content = renderParts(msg.parts, options);
      if (!content.trim()) {
        logged.add(msg.info.id);
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
        dbg(`log_message failed for ${msg.info.id}: ${reply}`);
        continue;
      }
      if (!reply.startsWith("📝")) {
        dbg(`log_message unexpected reply for ${msg.info.id}: ${reply.slice(0, 200)}`);
      }
      logged.add(msg.info.id);
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
