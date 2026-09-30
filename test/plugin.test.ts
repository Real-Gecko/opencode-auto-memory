import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "@opencode/plugin";

import AutoMemoryPlugin from "../src/index.ts";
import { SAVE_NUDGE } from "../src/kb.ts";

const testDir = mkdtempSync(join(tmpdir(), "auto-memory-plugin-"));
process.env.AUTO_MEMORY_DEBUG_PATH = join(testDir, "debug.log");

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("capture did not finish");
    await Bun.sleep(5);
  }
}

type PromptHook = (event: {
  sessionID: string;
  messageID: string;
  prompt: { text: string };
}) => Promise<void>;

describe("V2 plugin lifecycle", () => {
  test("consumes live V2 events while capture is slow and drains trailing work", async () => {
    let contextCalls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const captureStarted = new Promise<void>((resolve) => { started = resolve; });
    let consumed!: () => void;
    const eventsConsumed = new Promise<void>((resolve) => { consumed = resolve; });
    const context = {
      options: { injectContext: false, keywordNudge: false },
      location: { directory: "/w/", project: { id: "p", directory: "/w", canonical: "/w" } },
      session: {
        hook: async () => {},
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }),
        context: async () => {
          contextCalls += 1;
          if (contextCalls === 1) {
            started();
            await blocked;
          }
          return [];
        },
      },
      event: {
        subscribe: async function* () {
          yield { type: "session.inbox.delivered", location: { directory: "/w" }, data: { sessionID: "s" } };
          await captureStarted;
          for (const type of [
            "session.step.ended", "session.step.failed", "session.execution.succeeded",
            "session.execution.failed", "session.execution.interrupted",
          ]) {
            yield { type, location: { directory: "/w" }, data: { sessionID: "s" } };
          }
          // Neither token streaming nor another location should queue capture.
          yield { type: "session.text.delta", data: { sessionID: "s" } };
          yield { type: "session.step.ended", location: { directory: "/other" }, data: { sessionID: "foreign" } };
          consumed();
        },
      },
    };
    const cleanup = await AutoMemoryPlugin.setup(context as unknown as Plugin.Context);
    try {
      await Promise.race([
        eventsConsumed,
        Bun.sleep(1_000).then(() => { throw new Error("slow capture blocked event consumption"); }),
      ]);
      expect(contextCalls).toBe(1);
    } finally {
      release();
      await cleanup?.();
    }
    // One snapshot was running; completion events require one fresh snapshot.
    // Cleanup coalesces with that pending pass and waits for both.
    expect(contextCalls).toBe(2);
  });

  test("registers the prompt hook, handles idle, and flushes on cleanup", async () => {
    let promptHook: PromptHook | undefined;
    let contextCalls = 0;
    let finishEventLoop: (() => void) | undefined;
    const eventLoopFinished = new Promise<void>((resolve) => {
      finishEventLoop = resolve;
    });

    const session = {
      hook: async (name: string, callback: PromptHook) => {
        expect(name).toBe("prompt");
        promptHook = callback;
      },
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        title: "Lifecycle test",
      }),
      context: async ({ sessionID }: { sessionID: string }) => {
        expect(sessionID).toBe("session-1");
        contextCalls += 1;
        return [];
      },
    };

    const context = {
      options: {
        injectContext: false,
        keywordNudge: true,
      },
      location: {
        directory: "/workspace/project/src",
        project: {
          id: "project-1",
          directory: "/workspace/project",
          canonical: "/workspace/project",
        },
      },
      session,
      event: {
        subscribe: async function* () {
          yield {
            id: "event-1",
            created: Date.now(),
            type: "session.idle",
            data: { sessionID: "session-1" },
          };
          finishEventLoop?.();
        },
      },
    };

    const cleanup = await AutoMemoryPlugin.setup(context as unknown as Plugin.Context);
    expect(promptHook).toBeDefined();

    const prompt = {
      sessionID: "session-1",
      messageID: "message-1",
      prompt: { text: "remember this migration detail" },
    };
    await promptHook?.(prompt);
    expect(prompt.prompt.text).toBe(`remember this migration detail\n\n${SAVE_NUDGE}`);

    await Promise.race([
      eventLoopFinished,
      Bun.sleep(1_000).then(() => {
        throw new Error("event loop did not process session.idle");
      }),
    ]);
    await waitFor(() => contextCalls === 1);

    await cleanup?.();
    expect(contextCalls).toBe(2);
  });

  test("handles both idle event shapes and re-captures later status idle", async () => {
    let contextCalls = 0;
    let finishEventLoop: (() => void) | undefined;
    const eventLoopFinished = new Promise<void>((resolve) => {
      finishEventLoop = resolve;
    });

    const session = {
      hook: async () => {},
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, title: "Status test" }),
      context: async () => {
        contextCalls += 1;
        return [];
      },
    };

    const events: Array<{ type: string; data: Record<string, unknown> }> = [
      { type: "session.status", data: { sessionID: "s", status: { type: "idle" } } },
      { type: "session.idle", data: { sessionID: "s" } },
      { type: "session.status", data: { sessionID: "s", status: { type: "busy" } } },
      { type: "session.status", data: { sessionID: "s", status: { type: "idle" } } },
    ];

    const context = {
      options: { injectContext: false, keywordNudge: false },
      location: { directory: "/w", project: { id: "p", directory: "/w", canonical: "/w" } },
      session,
      event: {
        subscribe: async function* () {
          for (const event of events) {
            yield { id: "e", created: Date.now(), ...event };
          }
          finishEventLoop?.();
        },
      },
    };

    const cleanup = await AutoMemoryPlugin.setup(context as unknown as Plugin.Context);

    await Promise.race([
      eventLoopFinished,
      Bun.sleep(1_000).then(() => {
        throw new Error("event loop did not finish");
      }),
    ]);
    // A burst of idle notifications is coalesced without blocking the stream.
    await waitFor(() => contextCalls >= 1);

    await cleanup?.();
    expect(contextCalls).toBeGreaterThanOrEqual(2);
  });

  test("re-captures a legacy idle stream after a new prompt", async () => {
    let promptHook: PromptHook | undefined;
    let contextCalls = 0;
    let releaseSecondIdle: (() => void) | undefined;
    let finishEventLoop: (() => void) | undefined;
    let finishFirstCapture: (() => void) | undefined;
    const secondIdleReleased = new Promise<void>((resolve) => {
      releaseSecondIdle = resolve;
    });
    const firstCaptureFinished = new Promise<void>((resolve) => {
      finishFirstCapture = resolve;
    });
    const eventLoopFinished = new Promise<void>((resolve) => {
      finishEventLoop = resolve;
    });

    const context = {
      options: { injectContext: false, keywordNudge: false },
      location: { directory: "/w", project: { id: "p", directory: "/w", canonical: "/w" } },
      session: {
        hook: async (_name: string, callback: PromptHook) => {
          promptHook = callback;
        },
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }),
        context: async () => {
          contextCalls += 1;
          finishFirstCapture?.();
          return [];
        },
      },
      event: {
        subscribe: async function* () {
          yield { id: "idle-1", created: 1, type: "session.idle", data: { sessionID: "s" } };
          await secondIdleReleased;
          yield { id: "idle-2", created: 2, type: "session.idle", data: { sessionID: "s" } };
          finishEventLoop?.();
        },
      },
    };

    const cleanup = await AutoMemoryPlugin.setup(context as unknown as Plugin.Context);
    await firstCaptureFinished;
    await promptHook?.({ sessionID: "s", messageID: "new-turn", prompt: { text: "next turn" } });
    releaseSecondIdle?.();

    await Promise.race([
      eventLoopFinished,
      Bun.sleep(1_000).then(() => {
        throw new Error("legacy idle stream did not finish");
      }),
    ]);
    await waitFor(() => contextCalls === 2);

    await cleanup?.();
    expect(contextCalls).toBe(3);
  });

  test("debounces content updates when idle events are unavailable", async () => {
    let contextCalls = 0;
    let finishEventLoop: (() => void) | undefined;
    const eventLoopFinished = new Promise<void>((resolve) => {
      finishEventLoop = resolve;
    });

    const context = {
      options: { injectContext: false, keywordNudge: false },
      location: { directory: "/w", project: { id: "p", directory: "/w", canonical: "/w" } },
      session: {
        hook: async () => {},
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }),
        context: async () => {
          contextCalls += 1;
          return [];
        },
      },
      event: {
        subscribe: async function* () {
          yield {
            id: "content-1",
            created: 1,
            type: "session.message.content.updated",
            data: { sessionID: "s" },
          };
          yield {
            id: "content-2",
            created: 2,
            type: "session.message.content.updated",
            data: { sessionID: "s" },
          };
          finishEventLoop?.();
        },
      },
    };

    const cleanup = await AutoMemoryPlugin.setup(context as unknown as Plugin.Context);
    await eventLoopFinished;
    await Bun.sleep(650);
    expect(contextCalls).toBe(1);

    await cleanup?.();
    expect(contextCalls).toBe(2);
  });
});
