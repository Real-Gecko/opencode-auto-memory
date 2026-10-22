// Copy notes from an opencode-personal-knowledge database into the plugin's database.
// Usage: bun scripts/import-personal-knowledge.ts [path/to/knowledge.db]
// Note ids are kept, so references like "entry #43" stay valid. Notes whose id is
// already taken are skipped, so running it twice is harmless.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import { dbPath } from "../src/config.ts";
import { openDb } from "../src/db.ts";

const source =
  process.argv[2] ?? join(homedir(), ".local", "share", "opencode-personal-knowledge", "knowledge.db");

const rows = new Database(source, { readonly: true })
  .query("select id, title, content, tags, created_at, updated_at from knowledge_entries order by id")
  .all() as Array<{ id: number; title: string; content: string; tags: string | null; created_at: string; updated_at: string }>;

const db = openDb();
const insert = db.query(
  "insert or ignore into notes (id, title, content, tags, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
);
const count = () => (db.query("select count(*) as n from notes").get() as { n: number }).n;
const before = count();
db.transaction(() => {
  for (const row of rows) {
    const tags = (JSON.parse(row.tags || "[]") as string[]).join(", ");
    insert.run(row.id, row.title, row.content, tags, Date.parse(row.created_at), Date.parse(row.updated_at)).changes;
  }
})();
const imported = count() - before;

console.log(`${source} -> ${dbPath()}: imported ${imported} of ${rows.length} notes, skipped ${rows.length - imported}.`);
