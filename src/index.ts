import { basename } from "node:path";

import type { Plugin } from "@opencode-ai/plugin";

import {
  flushSessions,
  handleDeleted,
  handleIdle,
  oncePerSession,
  type CaptureClient,
} from "./capture.ts";
import { projectRootFrom, resolveOptions } from "./config.ts";
import { buildKeywordPattern, hasSaveIntent, SAVE_NUDGE } from "./kb.ts";
import { buildInjection } from "./inject.ts";
import { dbg, setLogLimit } from "./logger.ts";
import { closeMcp } from "./mcp.ts";

export const AutoMemoryPlugin: Plugin = async ({ client, directory, worktree }, pluginOptions) => {
  const options = resolveOptions(pluginOptions);
  setLogLimit(options.debugMaxBytes);
  const projectRoot = projectRootFrom(worktree, directory);
  const projectName = basename(projectRoot);
  const keywordPattern = buildKeywordPattern(options.keywordPatterns);
  const captureClient = client as unknown as CaptureClient;

  /** Sessions this process has touched, for the shutdown flush. */
  const touched = new Set<string>();
  /** Sessions already given a context block by this process. */
  const injected = new Set<string>();
  let flushed = false;

  dbg(
    `plugin loaded project="${projectName}" root="${projectRoot}" ` +
      `(worktree="${worktree ?? ""}" directory="${directory ?? ""}") inject=${options.injectContext}`,
  );

  const flush = async () => {
    if (flushed) return;
    flushed = true;
    if (touched.size === 0) return;
    dbg(`flush: draining ${touched.size} session(s)`);
    await flushSessions(captureClient, [...touched], options);
  };

  return {
    "chat.message": async (input, output) => {
      try {
        const sessionID = input.sessionID;
        if (!sessionID) return;
        touched.add(sessionID);

        const userText = output.parts
          .filter((part) => part.type === "text" && !part.synthetic)
          .map((part) => (part as { text?: string }).text ?? "")
          .join("\n")
          .trim();

        if (options.keywordNudge && userText && hasSaveIntent(userText, keywordPattern)) {
          dbg("chat.message: save intent detected");
          output.parts.push({
            id: `prt_auto-memory-nudge-${Date.now()}`,
            sessionID,
            messageID: output.message.id,
            type: "text",
            text: SAVE_NUDGE,
            synthetic: true,
          });
        }

        if (!options.injectContext || injected.has(sessionID)) return;
        // Claim the session before awaiting, so two messages in flight cannot
        // both inject.
        injected.add(sessionID);

        const sessionRes = await captureClient.session.get({ path: { id: sessionID } });
        if (sessionRes?.data?.parentID) {
          dbg("chat.message: skip injection for subagent session");
          return;
        }

        const started = Date.now();
        const block = await buildInjection(projectName, userText, options);
        if (!block) {
          dbg(`chat.message: nothing to inject (${Date.now() - started}ms)`);
          return;
        }

        output.parts.unshift({
          id: `prt_auto-memory-context-${Date.now()}`,
          sessionID,
          messageID: output.message.id,
          type: "text",
          text: block,
          synthetic: true,
        });
        dbg(`chat.message: injected ${block.length} chars in ${Date.now() - started}ms`);
      } catch (error) {
        dbg(`chat.message ERROR: ${(error as Error)?.message ?? error}`);
      }
    },

    event: async (input) => {
      const type: string = input.event.type;
      const properties = (input.event as { properties?: Record<string, unknown> }).properties ?? {};

      if (type === "message.updated") {
        const info = properties.info as { sessionID?: string } | undefined;
        if (info?.sessionID) touched.add(info.sessionID);
        return;
      }

      if (type === "session.idle") {
        const sessionID = properties.sessionID as string | undefined;
        if (!sessionID) return;
        dbg("event received: session.idle");
        touched.add(sessionID);
        await oncePerSession(sessionID, () => handleIdle(captureClient, sessionID, options));
        return;
      }

      if (type === "session.deleted") {
        const info = properties.info as { id?: string } | undefined;
        const sessionID = (properties.sessionID as string | undefined) ?? info?.id;
        if (!sessionID) return;
        dbg("event received: session.deleted");
        touched.delete(sessionID);
        await handleDeleted(sessionID, options);
        return;
      }

      if (type === "server.instance.disposed") {
        dbg("event received: server.instance.disposed");
        await flush();
      }
    },

    dispose: async () => {
      dbg("plugin dispose");
      await flush();
      closeMcp();
    },
  };
};
