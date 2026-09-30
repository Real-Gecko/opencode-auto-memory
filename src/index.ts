import { basename, resolve } from "node:path";

import type { Plugin } from "@opencode/plugin";

import {
  handleDeleted,
  handleIdle,
  oncePerSession,
  type CaptureClient,
} from "./capture.ts";
import { CaptureQueue } from "./capture-queue.ts";
import { projectRootFrom, resolveOptions } from "./config.ts";
import { buildKeywordPattern, hasSaveIntent, SAVE_NUDGE } from "./kb.ts";
import { buildInjection } from "./inject.ts";
import { dbg, setLogLimit } from "./logger.ts";
import { closeMcp } from "./mcp.ts";

/** Wait for a quiet period after streaming content before capturing. */
const CAPTURE_DEBOUNCE_MS = 500;

/**
 * V2 plugin definition. `Plugin.define` is the identity function, so a plain
 * `{ id, setup }` default export is exactly what the V2 loader registers — and
 * it keeps the bundle free of the SDK's dependency graph.
 */
export default {
  id: "auto-memory",
  async setup(ctx: Plugin.Context) {
    const options = resolveOptions(ctx.options);
    setLogLimit(options.debugMaxBytes);
    const projectRoot = projectRootFrom(ctx.location.project.directory, ctx.location.directory);
    const projectName = basename(projectRoot);
    const keywordPattern = buildKeywordPattern(options.keywordPatterns);
    const captureClient = ctx as unknown as CaptureClient;

    /** Sessions this process has touched, for the shutdown flush. */
    const touched = new Set<string>();
    /** Sessions already given a context block by this process. */
    const injected = new Set<string>();
    /** Debounced fallback timers for builds that do not emit session.idle. */
    const captureTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const queue = new CaptureQueue((error) => {
      dbg(`capture queue ERROR: ${(error as Error)?.message ?? error}`);
    });
    let flushed = false;

    dbg(
      `plugin loaded project="${projectName}" root="${projectRoot}" ` +
        `(directory="${ctx.location.directory}") inject=${options.injectContext}`,
    );

    const flush = async () => {
      if (flushed) return;
      flushed = true;
      dbg(`flush: draining ${touched.size} session(s)`);
      for (const sessionID of touched) {
        queue.enqueue(sessionID, () =>
          oncePerSession(sessionID, () => handleIdle(captureClient, sessionID, options)));
      }
      await queue.drain();
    };

    const onIdle = (sessionID: string, source: string) => {
      const timer = captureTimers.get(sessionID);
      if (timer !== undefined) {
        clearTimeout(timer);
        captureTimers.delete(sessionID);
      }
      touched.add(sessionID);
      dbg(`event received: ${source}`);
      queue.enqueue(sessionID, () =>
        oncePerSession(sessionID, () => handleIdle(captureClient, sessionID, options)));
    };

    const scheduleCapture = (sessionID: string) => {
      const previous = captureTimers.get(sessionID);
      if (previous !== undefined) clearTimeout(previous);
      captureTimers.set(
        sessionID,
        setTimeout(() => {
          captureTimers.delete(sessionID);
          onIdle(sessionID, "debounced session.message.content.updated");
        }, CAPTURE_DEBOUNCE_MS),
      );
    };

    // Recall + save-intent nudge: V2's prompt hook is the durable-admission
    // equivalent of V1's chat.message. User messages are plain text in V2, so
    // the context block and nudge become part of the admitted prompt text.
    // renderParts strips our own markers so capture never stores them back.
    await ctx.session.hook("prompt", async (event) => {
      try {
        const sessionID = event.sessionID;
        touched.add(sessionID);

        const userText = (event.prompt.text ?? "").trim();

        if (options.keywordNudge && userText && hasSaveIntent(userText, keywordPattern)) {
          dbg("prompt: save intent detected");
          event.prompt.text = `${event.prompt.text}\n\n${SAVE_NUDGE}`;
        }

        if (!options.injectContext || injected.has(sessionID)) return;
        // Claim the session before awaiting, so two prompts in flight cannot
        // both inject.
        injected.add(sessionID);

        const session = await captureClient.session.get({ sessionID });
        if (session?.parentID) {
          dbg("prompt: skip injection for subagent session");
          return;
        }

        const started = Date.now();
        const block = await buildInjection(projectName, userText, options);
        if (!block) {
          dbg(`prompt: nothing to inject (${Date.now() - started}ms)`);
          return;
        }

        event.prompt.text = `${block}\n\n${event.prompt.text}`;
        dbg(`prompt: injected ${block.length} chars in ${Date.now() - started}ms`);
      } catch (error) {
        dbg(`prompt ERROR: ${(error as Error)?.message ?? error}`);
      }
    });

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break;
          // The public stream spans every server location, not just this
          // plugin instance. Do not have every project index the same turn.
          const directory = (event as { location?: { directory?: string } }).location?.directory;
          if (directory && resolve(directory) !== resolve(ctx.location.directory)) continue;
          const type = typeof (event as { type?: unknown }).type === "string"
            ? (event as { type: string }).type
            : "";
          const data = ((event as { data?: Record<string, unknown> }).data ?? {}) as Record<
            string,
            unknown
          >;

          // Current V2 emits durable inbox/step/execution events. Content
          // replacement is replay-only now; retain it for older V2 builds.
          if (
            type === "session.inbox.delivered" ||
            type === "session.step.ended" ||
            type === "session.step.failed" ||
            type === "session.execution.succeeded" ||
            type === "session.execution.failed" ||
            type === "session.execution.interrupted"
          ) {
            const sessionID = data.sessionID;
            if (typeof sessionID === "string" && sessionID) onIdle(sessionID, type);
            continue;
          }

          if (type === "session.message.content.updated") {
            const sessionID = data.sessionID as string | undefined;
            if (sessionID) {
              touched.add(sessionID);
              // Compatibility fallback; never capture individual text deltas.
              scheduleCapture(sessionID);
            }
            continue;
          }

          if (type === "session.idle") {
            const sessionID = data.sessionID as string | undefined;
            if (!sessionID) continue;
            onIdle(sessionID, "session.idle");
            continue;
          }

          if (type === "session.status") {
            const sessionID = data.sessionID as string | undefined;
            const status = data.status as { type?: string } | undefined;
            if (!sessionID) continue;
            if (status?.type === "idle") {
              onIdle(sessionID, "session.status (idle)");
            }
            continue;
          }

          if (type === "session.deleted") {
            const sessionID = data.sessionID as string | undefined;
            if (!sessionID) continue;
            dbg("event received: session.deleted");
            const timer = captureTimers.get(sessionID);
            if (timer !== undefined) clearTimeout(timer);
            captureTimers.delete(sessionID);
            touched.delete(sessionID);
            // End the KB session only after its running capture has finished.
            queue.enqueue(sessionID, () => handleDeleted(sessionID, options));
          }
        }
      } catch (error) {
        dbg(`event loop ended: ${(error as Error)?.message ?? error}`);
      }
    })();

    return async () => {
      dbg("plugin dispose");
      controller.abort();
      for (const timer of captureTimers.values()) clearTimeout(timer);
      captureTimers.clear();
      await flush();
      closeMcp();
    };
  },
};
