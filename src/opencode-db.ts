import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SessionMessage } from "./capture.ts";

/**
 * The plugin API only exposes a session's current context, which ends at the
 * last compaction, so search hits are read back from opencode's own database
 * (read-only). This is opencode's internal schema: keep all knowledge of it here.
 */
export function opencodeDbPath(): string {
  return (
    process.env.AUTO_MEMORY_OPENCODE_DB ??
    join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db")
  );
}

let db: Database | undefined;
let openedPath: string | undefined;

function openOpencodeDb(): Database {
  const path = opencodeDbPath();
  if (db && openedPath === path) return db;
  db?.close();
  db = new Database(path, { readonly: true });
  openedPath = path;
  return db;
}

export function closeOpencodeDb(): void {
  db?.close();
  db = undefined;
  openedPath = undefined;
}

export function readMessage(sessionID: string, messageID: string): SessionMessage | undefined {
  try {
    const row = openOpencodeDb()
      .query("select id, type, data from session_message where id = ? and session_id = ?")
      .get(messageID, sessionID) as { id: string; type: string; data: string } | null;
    return row ? { ...(JSON.parse(row.data) as object), id: row.id, type: row.type } : undefined;
  } catch {
    return undefined;
  }
}

/** User and assistant messages of main (non-subagent) sessions. */
export function mainSessionMessages(): Array<{ id: string; sessionID: string }> {
  return openOpencodeDb()
    .query(
      "select m.id, m.session_id as sessionID from session_message m join session_v2 s on s.id = m.session_id " +
        "where s.parent_id is null and m.type in ('user', 'assistant')",
    )
    .all() as Array<{ id: string; sessionID: string }>;
}

export function sessionTitle(sessionID: string): string {
  try {
    const row = openOpencodeDb().query("select title from session_v2 where id = ?").get(sessionID) as {
      title: string | null;
    } | null;
    return row?.title ?? "";
  } catch {
    return "";
  }
}
