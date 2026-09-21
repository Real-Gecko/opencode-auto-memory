import { describe, expect, test } from "bun:test";

import { DEFAULTS } from "../src/config.ts";
import { autoRedactSecrets, isFullyPrivate, stripPrivate } from "../src/privacy.ts";
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

describe("autoRedactSecrets", () => {
  test("redacts values next to secret-like keys and keeps the key", () => {
    expect(autoRedactSecrets("token = sk-abcdef123456")).toBe("token = [REDACTED]");
    expect(autoRedactSecrets('"apiKey": "AbCdEf12345678"')).toBe('"apiKey": "[REDACTED]"');
  });

  test("is case and spacing tolerant", () => {
    expect(autoRedactSecrets("PASSWORD: hunter2hunter")).toBe("PASSWORD: [REDACTED]");
    expect(autoRedactSecrets("access-key AKIAEXAMPLEKEY12345")).toBe("access-key [REDACTED]");
    expect(autoRedactSecrets('clientSecret = "xyz123456789ab"')).toBe(
      'clientSecret = "[REDACTED]"',
    );
  });

  test("leaves short or unqualified values alone", () => {
    expect(autoRedactSecrets("secret = hunt")).toBe("secret = hunt");
    expect(autoRedactSecrets("the answer is 42")).toBe("the answer is 42");
    expect(autoRedactSecrets("mapping: {a: 1}")).toBe("mapping: {a: 1}");
    expect(autoRedactSecrets("commit abcdef0123456789")).toBe("commit abcdef0123456789");
  });

  test("redacts bearer tokens, JWTs and private key blocks", () => {
    const header = "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyzABCDE";
    expect(autoRedactSecrets(header)).toBe("Authorization: Bearer [REDACTED]");
    expect(autoRedactSecrets("jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMew")).toBe(
      "jwt=[REDACTED]",
    );
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgKB\n-----END RSA PRIVATE KEY-----";
    expect(autoRedactSecrets(key)).toBe("[REDACTED]");
  });

  test("redacts URL userinfo and keeps scheme and host", () => {
    expect(autoRedactSecrets("rtsp://user:pass@192.168.210.10:554/live")).toBe(
      "rtsp://[REDACTED]@192.168.210.10:554/live",
    );
    expect(autoRedactSecrets("postgresql://admin:hunter2@db:5432/catalog")).toBe(
      "postgresql://[REDACTED]@db:5432/catalog",
    );
    expect(autoRedactSecrets("https://token:abcdef12345678@example.com/x")).toBe(
      "https://[REDACTED]@example.com/x",
    );
  });

  test("leaves URLs without credentials alone", () => {
    expect(autoRedactSecrets("http://10.0.9.13:8000 ok")).toBe("http://10.0.9.13:8000 ok");
    expect(autoRedactSecrets("rtsp://camera1:554/live")).toBe("rtsp://camera1:554/live");
    expect(autoRedactSecrets("wss://user@example.com/x")).toBe("wss://user@example.com/x");
    expect(autoRedactSecrets("backup to rtsp://192.168.210.10:554 ok")).toBe(
      "backup to rtsp://192.168.210.10:554 ok",
    );
  });

  test("redacts several in one text and plays nice with markers", () => {
    expect(autoRedactSecrets("a=1 token=xhlH9ajLpM token=yqK3mWd8xR")).toBe(
      "a=1 token=[REDACTED] token=[REDACTED]",
    );
    expect(autoRedactSecrets("token = [REDACTED]")).toBe("token = [REDACTED]");
  });
});

describe("renderToolPart", () => {
  const bash: MessagePart = {
    type: "tool",
    name: "bash",
    state: {
      status: "completed",
      title: "echo",
      input: { command: "echo hi" },
      content: [{ type: "text", text: "hi" }],
    },
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

  test("keeps a clipped error reason (structured V2 error)", () => {
    const part: MessagePart = {
      type: "tool",
      name: "read",
      state: { status: "error", error: { message: "x".repeat(500) } },
    };
    const rendered = renderToolPart(part, DEFAULTS);
    expect(rendered).toContain("error: ");
    expect(rendered).toContain("[truncated 300 chars]");
  });

  test("never records knowledge-base tool output", () => {
    const part: MessagePart = {
      type: "tool",
      name: "personal-knowledge_search_knowledge",
      state: {
        status: "completed",
        input: { query: "merge" },
        content: [{ type: "text", text: "SECRET_RESULTS" }],
      },
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
      { type: "tool", name: "bash", state: { status: "completed", title: "ls" } },
    ];
    const rendered = renderParts(parts, DEFAULTS);
    expect(rendered).toBe("token is [REDACTED]\n\n[tool: bash] ls");
  });

  test("drops a fully private message body", () => {
    expect(renderParts([{ type: "text", text: "<private>all of it</private>" }], DEFAULTS)).toBe("");
  });

  test("strips the plugin's own recall block from V2 user text", () => {
    const parts: MessagePart[] = [
      {
        type: "text",
        text:
          "<memory-context>\nEntries from your personal knowledge base...\n</memory-context>\n\nwhat's the status of the router?",
      },
    ];
    const rendered = renderParts(parts, DEFAULTS);
    expect(rendered).toBe("what's the status of the router?");
  });

  test("strips the save-intent nudge from V2 user text", () => {
    const parts: MessagePart[] = [
      {
        type: "text",
        text: "remember this fix\n\n<memory-save-intent>\nPersist it with the personal-knowledge tools...\n</memory-save-intent>",
      },
    ];
    const rendered = renderParts(parts, DEFAULTS);
    expect(rendered).toBe("remember this fix");
  });
});

describe("autoRedact in rendering", () => {
  const curl: MessagePart = {
    type: "tool",
    name: "bash",
    state: {
      status: "completed",
      title: "curl",
      input: { command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnop12345678' https://x" },
    },
  };

  test("redacts secrets from tool input when enabled", () => {
    const rendered = renderToolPart(curl, DEFAULTS);
    expect(rendered).not.toContain("sk-abcdefghijklmnop12345678");
    expect(rendered).toContain("[REDACTED]");
  });

  test("leaves them alone when disabled", () => {
    const rendered = renderToolPart(curl, { ...DEFAULTS, autoRedact: false });
    expect(rendered).toContain("sk-abcdefghijklmnop12345678");
    expect(rendered).not.toContain("[REDACTED]");
  });

  test("redacts secrets from text blocks", () => {
    const rendered = renderParts(
      [{ type: "text", text: "posted key sk-abcdefghijklmnop12345678 to prod" }],
      DEFAULTS,
    );
    expect(rendered).not.toContain("sk-abcdefghijklmnop12345678");
  });
});
