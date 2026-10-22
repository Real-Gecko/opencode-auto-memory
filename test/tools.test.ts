import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "@opencode/plugin";

import { backfill, handleIdle, type SessionMessage } from "../src/capture.ts";
import { DEFAULTS } from "../src/config.ts";
import { searchMessages, sessionMessages } from "../src/db.ts";
import { buildInjection } from "../src/inject.ts";
import { registerTools } from "../src/tools.ts";

const dir = mkdtempSync(join(tmpdir(), "auto-memory-tools-"));
process.env.AUTO_MEMORY_DB_PATH = join(dir, "memory.db");
process.env.AUTO_MEMORY_DEBUG_PATH = join(dir, "debug.log");
process.env.AUTO_MEMORY_OPENCODE_DB = join(dir, "opencode.db");

type Execute = (input: Record<string, unknown>) => Promise<{ content: string }>;

const messages: SessionMessage[] = [
  { id: "m1", type: "user", time: { created: 1_000 }, text: "why is the lancedb store growing?" },
  {
    id: "m2",
    type: "assistant",
    time: { created: 2_000, completed: 2_500 },
    content: [{ type: "text", text: "Every write commits a new lancedb version." }],
  },
];

// Just the columns of opencode's own tables that the tools read.
const opencode = new Database(process.env.AUTO_MEMORY_OPENCODE_DB, { create: true });
opencode.run("create table session_v2 (id text primary key, title text, parent_id text)");
opencode.run("create table session_message (id text primary key, session_id text, type text, data text)");
opencode.run("insert into session_v2 values ('ses_1', 'LanceDB bloat', null), ('ses_old', 'Old', null), ('ses_sub', 'Sub', 'ses_old')");
const insert = (sessionID: string, { id, type, ...data }: SessionMessage) =>
  opencode.query("insert into session_message values (?, ?, ?, ?)").run(id, sessionID, type ?? "", JSON.stringify(data));
for (const msg of messages) insert("ses_1", msg);
insert("ses_old", { id: "o1", type: "user", time: { created: 10 }, text: "an old pelican question" });
insert("ses_old", { id: "o2", type: "assistant", time: { created: 11 }, content: [{ type: "text", text: "pelican still streaming" }] });
insert("ses_old", { id: "o3", type: "idle", time: { created: 12 } });
insert("ses_sub", { id: "s1", type: "user", time: { created: 13 }, text: "subagent pelican" });
opencode.close();

const session = {
  get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, title: "LanceDB bloat" }),
  context: async () => messages,
};

async function setup(): Promise<Record<string, Execute>> {
  const tools: Record<string, Execute> = {};
  const ctx = {
    session,
    tool: {
      transform: async (callback: (editor: { add: (tool: { name: string; execute: Execute; options: unknown }) => void }) => void) => {
        callback({
          add: (tool) => {
            expect(tool.options).toEqual({ codemode: false });
            tools[tool.name] = tool.execute;
          },
        });
      },
    },
  };
  await registerTools(ctx as unknown as Plugin.Context, DEFAULTS);
  return tools;
}

describe("note tools", () => {
  test("store, search, get, update and delete a note", async () => {
    const tools = await setup();
    expect((await tools.memory_store!({ title: "k22 setup", content: "uses bun 1.4", tags: ["k22", "rolling"] })).content)
      .toBe("Stored note #1.");
    await tools.memory_store!({ title: "unrelated", content: "nothing here" });

    expect((await tools.memory_search!({ query: "bun" })).content).toBe("#1 k22 setup [k22, rolling] — uses bun 1.4");
    expect((await tools.memory_search!({ query: "k22-setup: (" })).content).toContain("#1 k22 setup");
    expect((await tools.memory_search!({ query: "zzz" })).content).toBe("No notes found.");

    await tools.memory_update!({ id: 1, content: "uses bun 1.5" });
    const full = (await tools.memory_get!({ id: 1 })).content;
    expect(full).toStartWith("#1 k22 setup\nTags: k22, rolling\n");
    expect(full).toEndWith("\n\nuses bun 1.5");
    expect((await tools.memory_search!({ query: "1.4" })).content).toBe("No notes found.");

    expect(buildInjection("k22", "which bun do we use", DEFAULTS)).toContain('Matching "k22":\n- #1 k22 setup');

    expect((await tools.memory_delete!({ id: 1 })).content).toBe("Deleted note #1.");
    expect((await tools.memory_get!({ id: 1 })).content).toBe("Note #1 not found.");
    expect(buildInjection("k22", "", DEFAULTS)).toBe("");
  });
});

describe("conversation tools", () => {
  test("search returns ids and a preview, read returns the conversation", async () => {
    const tools = await setup();
    await handleIdle({ session }, "ses_1", DEFAULTS);

    const found = (await tools.session_search!({ query: "lancedb version" })).content;
    expect(found).toStartWith('- session ses_1 "LanceDB bloat" message m2 [agent, 1970-01-01T00:00:02.000Z]');
    expect(found).toContain("Every write commits a new lancedb version.");
    expect(found).not.toContain("message m1");
    expect((await tools.session_search!({ query: "lancedb" })).content).toContain("message m1 [user,");

    const read = (await tools.session_read!({ sessionID: "ses_1", messageID: "m2" })).content;
    expect(read).toBe(
      'Session ses_1 "LanceDB bloat", messages 2-2 of 2\n\n' +
        "[agent] m2 1970-01-01T00:00:02.000Z\nEvery write commits a new lancedb version.",
    );
    expect((await tools.session_read!({ sessionID: "nope" })).content).toBe("No indexed messages for session nope.");
  });
});

describe("backfill", () => {
  test("indexes stored history of main sessions once", async () => {
    await backfill(DEFAULTS);
    expect(sessionMessages("ses_old").map((hit) => hit.messageID)).toEqual(["o1"]);
    expect(sessionMessages("ses_sub")).toEqual([]);
    expect(searchMessages("pelican", 10).map((hit) => hit.messageID)).toEqual(["o1"]);
  });
});
