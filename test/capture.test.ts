import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

interface RpcRequest {
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

describe("V2 capture", () => {
  test("logs completed user and assistant messages through MCP", () => {
    const dir = mkdtempSync("/tmp/opencode/auto-memory-capture-");
    const fakeServer = join(dir, "fake-mcp.mjs");
    const requestLog = join(dir, "requests.jsonl");
    const statePath = join(dir, "state.json");
    const runner = join(dir, "runner.ts");

    writeFileSync(
      fakeServer,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify(request) + "\\n");
    if (request.id === undefined) continue;

    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
      continue;
    }

    const name = request.params?.name;
    const text = name === "start_logging_session"
      ? "Started logging session #41"
      : name === "log_message"
        ? "📝 logged"
        : "ok";
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text }] },
    }) + "\\n");
  }
});
`,
    );
    chmodSync(fakeServer, 0o755);

    const pluginUrl = pathToFileURL(join(import.meta.dir, "../src/index.ts")).href;
    const configUrl = pathToFileURL(join(import.meta.dir, "../src/config.ts")).href;
    const mcpUrl = pathToFileURL(join(import.meta.dir, "../src/mcp.ts")).href;
    writeFileSync(
      runner,
      `import plugin from ${JSON.stringify(pluginUrl)};
import { DEFAULTS } from ${JSON.stringify(configUrl)};
import { closeMcp } from ${JSON.stringify(mcpUrl)};
import { readFileSync } from "node:fs";

let completed = false;
async function waitForLogged(id: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(process.env.AUTO_MEMORY_STATE_PATH!, "utf8"));
      if (state.sessions["session-1"]?.logged?.includes(id)) return;
    } catch {}
    await Bun.sleep(10);
  }
  throw new Error("message not captured live: " + id);
}

const client = {
  session: {
    hook: async () => {},
    get: async ({ sessionID }: { sessionID: string }) => ({
      id: sessionID,
      title: "V2 migration",
    }),
    context: async () => [
      {
        id: "user-1",
        type: "user",
        time: { created: 1 },
        text: "<memory-context>old memory</memory-context>\\n\\nremember this fix\\n\\n<memory-save-intent>save it</memory-save-intent>",
      },
      {
        id: "assistant-1",
        type: "assistant",
        time: { created: 2, ...(completed ? { completed: 3 } : {}) },
        content: [
          { type: "text", text: "Implemented it." },
          {
            type: "tool",
            id: "tool-1",
            name: "bash",
            state: {
              status: "completed",
              input: { command: "echo done" },
              content: [{ type: "text", text: "done" }],
            },
          },
        ],
      },
      {
        id: "assistant-streaming",
        type: "assistant",
        time: { created: 4 },
        content: [{ type: "text", text: "not finished" }],
      },
      {
        id: "compaction-1",
        type: "compaction",
        time: { created: 5 },
        summary: "do not log",
      },
    ],
  },
};

const cleanup = await plugin.setup({
  ...client,
  options: {
    ...DEFAULTS,
    injectContext: false,
    serverCommand: ${JSON.stringify(fakeServer)},
    requestTimeoutMs: 5_000,
  },
  location: { directory: "/w", project: { directory: "/w" } },
  event: {
    subscribe: async function* () {
      yield { type: "session.inbox.delivered", data: { sessionID: "session-1", inboxID: "user-1" } };
      await waitForLogged("user-1");
      completed = true;
      yield { type: "session.step.ended", data: { sessionID: "session-1", assistantMessageID: "assistant-1" } };
      await waitForLogged("assistant-1");
      yield { type: "session.execution.succeeded", data: { sessionID: "session-1" } };
    },
  },
});
await waitForLogged("assistant-1");
await cleanup();
closeMcp();
`,
    );

    const result = spawnSync(process.execPath, [runner], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        AUTO_MEMORY_STATE_PATH: statePath,
        AUTO_MEMORY_DEBUG_PATH: join(dir, "debug.log"),
        AUTO_MEMORY_SERVER_CWD: join(dir, "server-cwd"),
        FAKE_MCP_LOG: requestLog,
      },
    });
    expect(result.status, result.stderr).toBe(0);

    const requests = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as RpcRequest);
    const calls = requests.filter((request) => request.method === "tools/call");
    expect(calls.map((request) => request.params?.name)).toEqual([
      "start_logging_session",
      "log_message",
      "log_message",
    ]);

    const logged = calls.slice(1).map((request) => request.params?.arguments ?? {});
    expect(logged[0]).toEqual({
      role: "user",
      content: "remember this fix",
      sessionId: 41,
    });
    expect(logged[1]?.role).toBe("agent");
    expect(logged[1]?.content).toContain("Implemented it.");
    expect(logged[1]?.content).toContain("[tool: bash]");
    expect(logged[1]?.content).toContain('input: {"command":"echo done"}');
    expect(logged[1]?.content).not.toContain("output: done");

    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      sessions: Record<string, { kbSessionID?: number; logged?: string[] }>;
    };
    expect(state.sessions["session-1"]?.kbSessionID).toBe(41);
    expect(state.sessions["session-1"]?.logged).toEqual(["user-1", "assistant-1"]);
  });
});
