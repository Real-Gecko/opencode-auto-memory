import type { AutoMemoryOptions } from "./config.ts";
import { isFullyPrivate, stripPrivate } from "./privacy.ts";

/**
 * Structural subset of the SDK's Part union. Kept local so a change in an
 * unrelated part type cannot break the build.
 */
export interface MessagePart {
  type?: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  tool?: string;
  state?: {
    status?: string;
    title?: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
  };
}

export function clip(text: unknown, limit: number): string {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

export function renderToolPart(part: MessagePart, options: AutoMemoryOptions): string {
  const state = part.state ?? {};
  const name = part.tool ?? "unknown";
  const header = state.title ? `[tool: ${name}] ${state.title}` : `[tool: ${name}]`;
  const lines = [header];

  const input = state.input;
  if (input && Object.keys(input).length > 0) {
    lines.push(`input: ${clip(JSON.stringify(input), options.toolInputLimit)}`);
  }

  // Recording what the knowledge base returned would store its own search
  // results back into it, so each lookup compounds as noise. Keep the query.
  if (name.includes("personal-knowledge")) {
    return lines.join("\n");
  }

  if (state.status === "error") {
    // Failures keep a short reason, since "this did not work" is a fact worth
    // recalling.
    lines.push(`error: ${clip(state.error || "failed", options.toolErrorLimit)}`);
  } else if (options.captureToolOutput && state.status === "completed" && state.output) {
    lines.push(`output: ${clip(state.output, options.toolOutputLimit)}`);
  } else if (state.status && state.status !== "completed") {
    lines.push(`status: ${state.status}`);
  }

  return lines.join("\n");
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
      const text = part.text?.trim();
      if (!text) continue;
      if (isFullyPrivate(text)) continue;
      blocks.push(stripPrivate(text).trim());
    } else if (part.type === "tool") {
      blocks.push(renderToolPart(part, options));
    }
  }
  return blocks.join("\n\n");
}
