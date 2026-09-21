import { describe, expect, test } from "bun:test";

import type { Plugin } from "@opencode/plugin";

import AutoMemoryPlugin from "../src/index.ts";
import { SAVE_NUDGE } from "../src/kb.ts";

type PromptHook = (event: {
  sessionID: string;
  messageID: string;
  prompt: { text: string };
}) => Promise<void>;

describe("V2 plugin lifecycle", () => {
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
    expect(contextCalls).toBe(1);

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
    // Both idle event shapes safely recheck persisted state; busy itself does not capture.
    expect(contextCalls).toBe(3);

    await cleanup?.();
    expect(contextCalls).toBe(4);
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
    expect(contextCalls).toBe(2);

    await cleanup?.();
    expect(contextCalls).toBe(3);
  });
});
