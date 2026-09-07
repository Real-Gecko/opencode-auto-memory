import { describe, expect, test } from "bun:test";

import { DEFAULTS } from "../src/config.ts";
import { isFullyPrivate, stripPrivate } from "../src/privacy.ts";
import { renderParts, renderToolPart, type MessagePart } from "../src/render.ts";

describe("privacy", () => {
  test("redacts private spans and keeps the rest", () => {
    expect(stripPrivate("key is <private>sk-abc</private> ok")).toBe("key is [REDACTED] ok");
  });

  test("is case and newline tolerant", () => {
    expect(stripPrivate("<PRIVATE>a\nb</PRIVATE>")).toBe("[REDACTED]");
  });

  test("detects a fully private message", () => {
    expect(isFullyPrivate("<private>everything</private>")).toBe(true);
    expect(isFullyPrivate("visible <private>hidden</private>")).toBe(false);
  });
});

describe("renderToolPart", () => {
  const bash: MessagePart = {
    type: "tool",
    tool: "bash",
    state: { status: "completed", title: "echo", input: { command: "echo hi" }, output: "hi" },
  };

  test("keeps the call and drops the output by default", () => {
    const rendered = renderToolPart(bash, DEFAULTS);
    expect(rendered).toContain("[tool: bash] echo");
    expect(rendered).toContain('input: {"command":"echo hi"}');
    expect(rendered).not.toContain("hi\n");
    expect(rendered).not.toContain("output:");
  });

  test("captures output when asked to", () => {
    expect(renderToolPart(bash, { ...DEFAULTS, captureToolOutput: true })).toContain("output: hi");
  });

  test("keeps a clipped error reason", () => {
    const part: MessagePart = {
      type: "tool",
      tool: "read",
      state: { status: "error", error: "x".repeat(500) },
    };
    const rendered = renderToolPart(part, DEFAULTS);
    expect(rendered).toContain("error: ");
    expect(rendered).toContain("[truncated 300 chars]");
  });

  test("never records knowledge-base tool output", () => {
    const part: MessagePart = {
      type: "tool",
      tool: "personal-knowledge_search_knowledge",
      state: { status: "completed", input: { query: "merge" }, output: "SECRET_RESULTS" },
    };
    const rendered = renderToolPart(part, { ...DEFAULTS, captureToolOutput: true });
    expect(rendered).toContain('input: {"query":"merge"}');
    expect(rendered).not.toContain("SECRET_RESULTS");
  });
});

describe("renderParts", () => {
  test("skips synthetic and ignored text, redacts private spans", () => {
    const parts: MessagePart[] = [
      { type: "text", text: "injected context", synthetic: true },
      { type: "text", text: "ignored", ignored: true },
      { type: "text", text: "token is <private>sk-1</private>" },
      { type: "reasoning", text: "thinking" } as MessagePart,
      { type: "tool", tool: "bash", state: { status: "completed", title: "ls" } },
    ];
    const rendered = renderParts(parts, DEFAULTS);
    expect(rendered).toBe("token is [REDACTED]\n\n[tool: bash] ls");
  });

  test("drops a fully private message body", () => {
    expect(renderParts([{ type: "text", text: "<private>all of it</private>" }], DEFAULTS)).toBe("");
  });
});
