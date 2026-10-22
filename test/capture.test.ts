import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleDeleted, handleIdle, type CaptureClient, type SessionMessage } from "../src/capture.ts";
import { DEFAULTS } from "../src/config.ts";
import { searchMessages, sessionMessages } from "../src/db.ts";

const dir = mkdtempSync(join(tmpdir(), "auto-memory-capture-"));
process.env.AUTO_MEMORY_DB_PATH = join(dir, "memory.db");
process.env.AUTO_MEMORY_DEBUG_PATH = join(dir, "debug.log");

const messages: SessionMessage[] = [
  {
    id: "user-1",
    type: "user",
    time: { created: 1 },
    text: "<memory-context>old memory zebra</memory-context>\n\nremember this fix\n\n<memory-save-intent>save it</memory-save-intent>",
  },
  {
    id: "assistant-1",
    type: "assistant",
    time: { created: 2, completed: 3 },
    content: [
      { type: "reasoning", text: "considering the flamingo approach" },
      { type: "text", text: "Implemented it." },
      {
        type: "tool",
        name: "bash",
        // Output is present on real messages and must not be indexed.
        state: { status: "completed", input: { command: "echo done" }, content: [{ type: "text", text: "UNIQUEOUTPUT" }] } as object,
      },
    ],
  },
  { id: "assistant-streaming", type: "assistant", time: { created: 4 }, content: [{ type: "text", text: "unfinished walrus" }] },
  { id: "compaction-1", type: "compaction", time: { created: 5 } },
];

const client = {
  session: {
    get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, title: "Capture test" }),
    context: async () => messages,
  },
} satisfies CaptureClient;

describe("V2 capture", () => {
  test("indexes completed user and assistant messages without storing tool output", async () => {
    await handleIdle(client, "session-1", DEFAULTS);
    await handleIdle(client, "session-1", DEFAULTS);

    expect(sessionMessages("session-1").map((hit) => [hit.messageID, hit.role])).toEqual([
      ["user-1", "user"],
      ["assistant-1", "agent"],
    ]);
    expect(searchMessages("remember fix", 10).map((hit) => hit.messageID)).toEqual(["user-1"]);
    expect(searchMessages("flamingo", 10).map((hit) => hit.messageID)).toEqual(["assistant-1"]);
    expect(searchMessages("echo", 10).map((hit) => hit.messageID)).toEqual(["assistant-1"]);
    expect(searchMessages("UNIQUEOUTPUT", 10)).toEqual([]);
    expect(searchMessages("zebra", 10)).toEqual([]);
    expect(searchMessages("walrus", 10)).toEqual([]);
  });

  test("skips subagent sessions", async () => {
    const subagent = { session: { ...client.session, get: async () => ({ id: "child", parentID: "p" }) } };
    await handleIdle(subagent, "child", DEFAULTS);
    expect(sessionMessages("child")).toEqual([]);
  });

  test("drops a deleted session from the index", async () => {
    await handleDeleted("session-1");
    expect(sessionMessages("session-1")).toEqual([]);
    expect(searchMessages("flamingo", 10)).toEqual([]);
  });
});
