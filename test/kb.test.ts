import { describe, expect, test } from "bun:test";

import { DEFAULTS, projectRootFrom } from "../src/config.ts";
import {
  buildKeywordPattern,
  formatContextBlock,
  hasSaveIntent,
  isTranscript,
  parseSemanticSearch,
  parseTextSearch,
  rankProjectEntries,
} from "../src/kb.ts";

// Verbatim shapes emitted by opencode-personal-knowledge's mcp-server.js.
const TEXT_SEARCH_OUTPUT = `Found 2 result(s) for "auto-memory":

**auto-memory chat-indexing plugin — merged version** (ID: 43)
Auto-memory chat-indexing plugin: ~/.config/opencode/plugins/auto-memory.ts on both machines...
Tags: opencode, plugin, auto-memory

---

**personal-knowledge MCP: vector id collision** (ID: 56)
Findings and fixes from 2026-09-05 on the MCP server...
Tags: opencode, personal-knowledge, bug`;

const SEMANTIC_SEARCH_OUTPUT = `## Found 2 similar entries:

### 1. auto-memory chat-indexing plugin (87% similar)
**ID:** 43
**Tags:** opencode, plugin

Auto-memory chat-indexing plugin state...

---

### 2. Greeting (61% similar)
**ID:** 1902
**Tags:** session:37, message

user: hello there...

---

`;

describe("parseTextSearch", () => {
  const entries = parseTextSearch(TEXT_SEARCH_OUTPUT, DEFAULTS.injectExcerptChars);

  test("finds every result", () => {
    expect(entries.map((entry) => entry.id)).toEqual([43, 56]);
  });

  test("keeps title, excerpt and tags apart", () => {
    expect(entries[0]?.title).toBe("auto-memory chat-indexing plugin — merged version");
    expect(entries[0]?.excerpt).toContain("~/.config/opencode/plugins/auto-memory.ts");
    expect(entries[0]?.excerpt).not.toContain("Tags:");
    expect(entries[0]?.tags).toEqual(["opencode", "plugin", "auto-memory"]);
  });

  test("returns nothing for the empty reply", () => {
    expect(parseTextSearch('No results found for: "nope"', 200)).toEqual([]);
    expect(parseTextSearch("", 200)).toEqual([]);
  });

  test("clips the excerpt to the configured length", () => {
    const long = parseTextSearch(TEXT_SEARCH_OUTPUT, 20);
    expect(long[0]?.excerpt.length).toBeLessThanOrEqual(23);
  });
});

describe("parseSemanticSearch", () => {
  const entries = parseSemanticSearch(SEMANTIC_SEARCH_OUTPUT, DEFAULTS.injectExcerptChars);

  test("reads ids and similarity", () => {
    expect(entries.map((entry) => [entry.id, entry.similarity])).toEqual([
      [43, 87],
      [1902, 61],
    ]);
  });

  test("recognises a logged transcript by its session tag", () => {
    expect(entries.filter(isTranscript).map((entry) => entry.id)).toEqual([1902]);
  });

  test("returns nothing for the empty reply", () => {
    expect(parseSemanticSearch("No similar knowledge entries found.", 200)).toEqual([]);
  });
});

describe("formatContextBlock", () => {
  const [project, related] = [
    parseTextSearch(TEXT_SEARCH_OUTPUT, DEFAULTS.injectExcerptChars),
    parseSemanticSearch(SEMANTIC_SEARCH_OUTPUT, DEFAULTS.injectExcerptChars).filter(
      (entry) => !isTranscript(entry),
    ),
  ];

  test("lists both sections and stays inside the entry cap", () => {
    const block = formatContextBlock("k22", project, related, { ...DEFAULTS, maxInjectEntries: 1 });
    expect(block).toStartWith("<memory-context>");
    expect(block).toEndWith("</memory-context>");
    expect(block).toContain('Matching "k22":');
    expect(block).toContain("#43");
    expect(block).not.toContain("#56");
  });

  test("does not repeat an entry that both lookups returned", () => {
    const block = formatContextBlock("k22", project, related, DEFAULTS);
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
    { id: 43, title: "auto-memory plugin", excerpt: "mentions hw2-debugger", tags: ["opencode"] },
    { id: 51, title: "hw2-debugger — current state (rolling)", excerpt: "", tags: ["rolling"] },
    { id: 37, title: "hw2-debugger engine internals", excerpt: "", tags: ["lua4"] },
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
