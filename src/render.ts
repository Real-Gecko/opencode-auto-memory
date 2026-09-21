import type { AutoMemoryOptions } from "./config.ts";
import { autoRedactSecrets, isFullyPrivate, stripPrivate } from "./privacy.ts";

/**
 * Structural subset of the V2 Part/Content shapes this module needs. Kept
 * local so a change in an unrelated part type cannot break the build.
 */
export interface MessagePart {
  type?: string;
  text?: string;
  /** V2 tool name. */
  name?: string;
  synthetic?: boolean;
  ignored?: boolean;
  state?: {
    status?: string;
    title?: string;
    input?: Record<string, unknown>;
    /** V2 tool output content. */
    content?: Array<{ type?: string; text?: string }>;
    /** V1 tool output string (legacy). */
    output?: string;
    error?: string | { message?: string };
  };
}

/**
 * V2 injects the recall block and save-intent nudge inline into the admitted
 * user prompt text (messages are plain text now, not parts). Strip those
 * markers so capture never stores the plugin's own output back into the KB.
 */
const OWN_INJECTION_BLOCKS =
  /<memory-context>[\s\S]*?<\/memory-context>|<memory-save-intent>[\s\S]*?<\/memory-save-intent>/g;

export function clip(text: unknown, limit: number): string {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function toolOutput(state: NonNullable<MessagePart["state"]>): string {
  if (typeof state.output === "string") return state.output;
  return (state.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function errorReason(error: string | { message?: string } | undefined): string {
  if (typeof error === "string") return error;
  return error?.message ?? "failed";
}

export function renderToolPart(part: MessagePart, options: AutoMemoryOptions): string {
  const state = part.state ?? {};
  const name = part.name ?? "unknown";
  const header = state.title ? `[tool: ${name}] ${state.title}` : `[tool: ${name}]`;
  const lines = [header];
  const finish = (text: string) => (options.autoRedact ? autoRedactSecrets(text) : text);

  const input = state.input;
  if (input && Object.keys(input).length > 0) {
    lines.push(`input: ${clip(JSON.stringify(input), options.toolInputLimit)}`);
  }

  // Recording what the knowledge base returned would store its own search
  // results back into it, so each lookup compounds as noise. Keep the query.
  if (name.includes("personal-knowledge")) {
    return finish(lines.join("\n"));
  }

  if (state.status === "error") {
    // Failures keep a short reason, since "this did not work" is a fact worth
    // recalling.
    lines.push(`error: ${clip(errorReason(state.error), options.toolErrorLimit)}`);
  } else if (options.captureToolOutput && state.status === "completed") {
    const output = toolOutput(state);
    if (output.trim()) lines.push(`output: ${clip(output, options.toolOutputLimit)}`);
  } else if (state.status && state.status !== "completed") {
    lines.push(`status: ${state.status}`);
  }

  return finish(lines.join("\n"));
}

/**
 * Tool output is dropped by default: it was 79% of everything in the store and
 * is almost never what a later search is looking for -- the call is the useful
 * record, not what it printed.
 */
export function renderParts(
  parts: MessagePart[] | undefined,
  options: AutoMemoryOptions,
): string {
  const blocks: string[] = [];
  for (const part of parts ?? []) {
    if (part.type === "text") {
      if (part.synthetic || part.ignored) continue;
      const text = part.text?.trim() ?? "";
      // The plugin's own recall block / nudge live inline in V2 user text;
      // drop them before anything else so they are never stored.
      const withoutOwn = text.replace(OWN_INJECTION_BLOCKS, "").trim();
      if (!withoutOwn) continue;
      if (isFullyPrivate(withoutOwn)) continue;
      let cleaned = stripPrivate(withoutOwn).trim();
      if (options.autoRedact) cleaned = autoRedactSecrets(cleaned);
      blocks.push(cleaned);
    } else if (part.type === "tool") {
      blocks.push(renderToolPart(part, options));
    }
  }
  return blocks.join("\n\n");
}
