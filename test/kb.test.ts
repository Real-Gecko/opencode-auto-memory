import { describe, expect, test } from "bun:test";

import { DEFAULTS, projectRootFrom } from "../src/config.ts";
import type { Note } from "../src/db.ts";
import {
  buildKeywordPattern,
  formatContextBlock,
  hasSaveIntent,
  rankProjectEntries,
} from "../src/kb.ts";

const note = (id: number, title: string, tags: string[] = [], content = ""): Note => ({
  id, title, content, tags, created_at: 0, updated_at: 0,
});

describe("formatContextBlock", () => {
  const project = [note(43, "k22 rolling", ["k22", "rolling"], "state of k22"), note(56, "k22 network")];
  const related = [note(43, "k22 rolling"), note(7, "bun versions")];

  test("lists both sections and stays inside the entry cap", () => {
    const block = formatContextBlock("k22", project, related, { ...DEFAULTS, maxInjectEntries: 1 });
    expect(block).toStartWith("<memory-context>");
    expect(block).toEndWith("</memory-context>");
    expect(block).toContain('Matching "k22":');
    expect(block).toContain("- #43 k22 rolling — state of k22");
    expect(block).not.toContain("#56");
    expect(block).toContain("#7 bun versions");
  });

  test("does not repeat an entry that both lookups returned", () => {
    const block = formatContextBlock("k22", project, related.slice(0, 1), DEFAULTS);
    expect(block.match(/#43/g)?.length).toBe(1);
    expect(block).not.toContain("Possibly relevant");
  });

  test("is empty when there is nothing to say", () => {
    expect(formatContextBlock("k22", [], [], DEFAULTS)).toBe("");
  });
});

describe("hasSaveIntent", () => {
  const pattern = buildKeywordPattern(DEFAULTS.keywordPatterns);

  test("fires on save phrasings", () => {
    expect(hasSaveIntent("remember that we use bun 1.4.0", pattern)).toBe(true);
    expect(hasSaveIntent("don't forget the glibc lesson", pattern)).toBe(true);
    expect(hasSaveIntent("запомни это", pattern)).toBe(true);
  });

  test("stays quiet otherwise", () => {
    expect(hasSaveIntent("what does this function do?", pattern)).toBe(false);
  });

  test("ignores matches inside code", () => {
    expect(hasSaveIntent("run `remember --help`", pattern)).toBe(false);
    expect(hasSaveIntent("```\nremember()\n```", pattern)).toBe(false);
  });

  test("honours extra patterns", () => {
    expect(hasSaveIntent("log this decision", buildKeywordPattern(["log\\s+this"]))).toBe(true);
  });
});

describe("rankProjectEntries", () => {
  const entries = [
    note(43, "auto-memory plugin", ["opencode"], "mentions hw2-debugger"),
    note(51, "hw2-debugger — current state (rolling)", ["rolling"]),
    note(37, "hw2-debugger engine internals", ["lua4"]),
  ];

  test("puts the project's own rolling entry first", () => {
    expect(rankProjectEntries(entries, "hw2-debugger").map((entry) => entry.id)).toEqual([51, 37, 43]);
  });

  test("keeps the original order when nothing scores", () => {
    expect(rankProjectEntries(entries, "unrelated").map((entry) => entry.id)).toEqual([43, 51, 37]);
  });
});

describe("projectRootFrom", () => {
  test("prefers the worktree", () => {
    expect(projectRootFrom("/home/u/Development/proj", "/home/u/Development/proj/src")).toBe(
      "/home/u/Development/proj",
    );
  });

  test("skips a root with no usable name", () => {
    expect(projectRootFrom("/", "/tmp/scratch", "/fallback")).toBe("/tmp/scratch");
    expect(projectRootFrom("", "", "/fallback")).toBe("/fallback");
    expect(projectRootFrom(undefined, undefined, "/fallback")).toBe("/fallback");
  });

  test("falls back when every candidate is unusable", () => {
    expect(projectRootFrom("/", "/", "/")).toBe("/");
  });
});
