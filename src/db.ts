import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { dbPath } from "./config.ts";

/**
 * Notes are stored here. Conversations are only indexed: `messages_fts` is a
 * contentless FTS5 table, so it keeps the search index but no message text, and
 * a hit is resolved back to opencode's own session and message ids.
 */
const SCHEMA = `
create table if not exists notes (
  id integer primary key,
  title text not null,
  content text not null,
  tags text not null default '',
  created_at integer not null,
  updated_at integer not null
);
create virtual table if not exists notes_fts using fts5(
  title, content, tags, content='notes', content_rowid='id', tokenize='porter unicode61'
);
create trigger if not exists notes_ai after insert on notes begin
  insert into notes_fts(rowid, title, content, tags) values (new.id, new.title, new.content, new.tags);
end;
create trigger if not exists notes_ad after delete on notes begin
  insert into notes_fts(notes_fts, rowid, title, content, tags) values ('delete', old.id, old.title, old.content, old.tags);
end;
create trigger if not exists notes_au after update on notes begin
  insert into notes_fts(notes_fts, rowid, title, content, tags) values ('delete', old.id, old.title, old.content, old.tags);
  insert into notes_fts(rowid, title, content, tags) values (new.id, new.title, new.content, new.tags);
end;
create table if not exists messages (
  id integer primary key,
  message_id text not null unique,
  session_id text not null,
  role text not null,
  time integer
);
create index if not exists messages_session on messages(session_id);
create virtual table if not exists messages_fts using fts5(
  text, content='', contentless_delete=1, tokenize='porter unicode61'
);
`;

let db: Database | undefined;
let openedPath: string | undefined;

export function openDb(): Database {
  const path = dbPath();
  if (db && openedPath === path) return db;
  db?.close();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  openedPath = path;
  // Several opencode processes can share the file.
  db.run("pragma busy_timeout = 5000");
  db.run("pragma journal_mode = WAL");
  db.run(SCHEMA);
  return db;
}

export function closeDb(): void {
  db?.close();
  db = undefined;
  openedPath = undefined;
}

export interface Note {
  id: number;
  title: string;
  content: string;
  tags: string[];
  created_at: number;
  updated_at: number;
}

interface NoteRow extends Omit<Note, "tags"> {
  tags: string;
}

const toNote = (row: NoteRow): Note => ({
  ...row,
  tags: row.tags ? row.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
});

const joinTags = (tags: string[] | undefined) =>
  (tags ?? []).map((tag) => tag.trim()).filter(Boolean).join(", ");

/**
 * Turn free text into a query that cannot be an FTS5 syntax error: every word
 * becomes a quoted term and the terms are OR-ed, so bm25 ranks by how many and
 * how rare the matching words are.
 */
export function anyWords(text: string): string {
  const words = text.match(/[\p{L}\p{N}_]+(?:[-.][\p{L}\p{N}_]+)*/gu) ?? [];
  const unique = [...new Set(words.filter((word) => word.length > 2).map((word) => word.toLowerCase()))];
  return unique.slice(0, 32).map((word) => `"${word}"`).join(" OR ");
}

/** Run an FTS query as written, and as plain words when it is not valid FTS5 syntax. */
function match<T>(query: string, run: (expression: string) => T[]): T[] {
  try {
    return run(query);
  } catch (error) {
    if (!/fts5|syntax|no such column/i.test((error as Error).message)) throw error;
    const fallback = anyWords(query);
    return fallback ? run(fallback) : [];
  }
}

export function storeNote(title: string, content: string, tags?: string[]): Note {
  const now = Date.now();
  const row = openDb()
    .query(
      "insert into notes (title, content, tags, created_at, updated_at) values (?, ?, ?, ?, ?) returning *",
    )
    .get(title, content, joinTags(tags), now, now) as NoteRow;
  return toNote(row);
}

export function getNote(id: number): Note | undefined {
  const row = openDb().query("select * from notes where id = ?").get(id) as NoteRow | null;
  return row ? toNote(row) : undefined;
}

export function updateNote(
  id: number,
  changes: { title?: string; content?: string; tags?: string[] },
): Note | undefined {
  const current = getNote(id);
  if (!current) return undefined;
  const row = openDb()
    .query("update notes set title = ?, content = ?, tags = ?, updated_at = ? where id = ? returning *")
    .get(
      changes.title ?? current.title,
      changes.content ?? current.content,
      changes.tags ? joinTags(changes.tags) : joinTags(current.tags),
      Date.now(),
      id,
    ) as NoteRow;
  return toNote(row);
}

export function deleteNote(id: number): boolean {
  return openDb().query("delete from notes where id = ?").run(id).changes > 0;
}

export function searchNotes(query: string, limit: number): Note[] {
  if (!query.trim()) return [];
  const statement = openDb().query(
    "select notes.* from notes_fts join notes on notes.id = notes_fts.rowid " +
      "where notes_fts match ? order by rank limit ?",
  );
  return match(query, (expression) => statement.all(expression, limit) as NoteRow[]).map(toNote);
}

export function indexedMessageIDs(): Set<string> {
  const rows = openDb().query("select message_id from messages").values() as Array<[string]>;
  return new Set(rows.map(([id]) => id));
}

export function inTransaction(task: () => void): void {
  openDb().transaction(task)();
}

export function isIndexed(messageID: string): boolean {
  return openDb().query("select 1 from messages where message_id = ?").get(messageID) !== null;
}

export function indexMessage(
  message: { messageID: string; sessionID: string; role: string; time?: number },
  text: string,
): void {
  const database = openDb();
  database.transaction(() => {
    // Another opencode process may have indexed it first.
    const row = database
      .query(
        "insert into messages (message_id, session_id, role, time) values (?, ?, ?, ?) " +
          "on conflict (message_id) do nothing returning id",
      )
      .get(message.messageID, message.sessionID, message.role, message.time ?? Date.now()) as {
      id: number;
    } | null;
    if (row && text) database.query("insert into messages_fts (rowid, text) values (?, ?)").run(row.id, text);
  })();
}

export function forgetSessionIndex(sessionID: string): void {
  const database = openDb();
  database.transaction(() => {
    database
      .query("delete from messages_fts where rowid in (select id from messages where session_id = ?)")
      .run(sessionID);
    database.query("delete from messages where session_id = ?").run(sessionID);
  })();
}

export interface MessageHit {
  messageID: string;
  sessionID: string;
  role: string;
  time: number;
}

export function sessionMessages(sessionID: string): MessageHit[] {
  return openDb()
    .query(
      "select message_id as messageID, session_id as sessionID, role, time from messages " +
        "where session_id = ? order by time, id",
    )
    .all(sessionID) as MessageHit[];
}

export function searchMessages(query: string, limit: number): MessageHit[] {
  if (!query.trim()) return [];
  const statement = openDb().query(
    "select m.message_id as messageID, m.session_id as sessionID, m.role, m.time " +
      "from messages_fts join messages m on m.id = messages_fts.rowid " +
      "where messages_fts match ? order by rank limit ?",
  );
  return match(query, (expression) => statement.all(expression, limit) as MessageHit[]);
}
