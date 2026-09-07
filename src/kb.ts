import type { AutoMemoryOptions } from "./config.ts";

export interface KbEntry {
  id: number;
  title: string;
  excerpt: string;
  tags: string[];
  /** 0-100, only present for semantic hits. */
  similarity?: number;
}

const BLOCK_SEPARATOR = /\n*-{3,}\n*/;

function cleanExcerpt(text: string, limit: number): string {
  const collapsed = text
    .replace(/\s*\n\s*/g, " ")
    .replace(/\.{3,}$/, "")
    .trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit).trimEnd()}...` : collapsed;
}

function parseTags(block: string): string[] {
  const match = block.match(/^\*{0,2}Tags:?\*{0,2}\s*(.+)$/m);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Parse `search_knowledge_text` output:
 *
 *   Found 2 result(s) for "query":
 *
 *   **Title** (ID: 43)
 *   first 200 chars of content...
 *   Tags: a, b
 */
export function parseTextSearch(output: string, excerptChars: number): KbEntry[] {
  if (!output || output.startsWith("No results found")) return [];
  const body = output.replace(/^Found \d+ result\(s\)[^\n]*\n+/, "");
  const entries: KbEntry[] = [];

  for (const block of body.split(BLOCK_SEPARATOR)) {
    const header = block.match(/\*\*(.+?)\*\*\s*\(ID:\s*(\d+)\)/);
    if (!header?.[1] || !header[2]) continue;
    const rest = block
      .slice((header.index ?? 0) + header[0].length)
      .replace(/^\*{0,2}Tags:?\*{0,2}.*$/gm, "")
      .trim();
    entries.push({
      id: Number(header[2]),
      title: header[1].trim(),
      excerpt: cleanExcerpt(rest, excerptChars),
      tags: parseTags(block),
    });
  }
  return entries;
}

/**
 * Parse `search_knowledge` output:
 *
 *   ## Found 2 similar entries:
 *
 *   ### 1. Title (87% similar)
 *   **ID:** 43
 *   **Tags:** a, b
 *
 *   preview...
 */
export function parseSemanticSearch(output: string, excerptChars: number): KbEntry[] {
  if (!output || !output.includes("**ID:**")) return [];
  const entries: KbEntry[] = [];

  for (const block of output.split(BLOCK_SEPARATOR)) {
    const header = block.match(/###\s*\d+\.\s*(.+?)\s*\((\d+)%\s*similar\)/);
    const idMatch = block.match(/\*\*ID:\*\*\s*(\d+)/);
    if (!header?.[1] || !header[2] || !idMatch?.[1]) continue;
    const rest = block
      .slice((idMatch.index ?? 0) + idMatch[0].length)
      .replace(/^\*{0,2}Tags:?\*{0,2}.*$/gm, "")
      .trim();
    entries.push({
      id: Number(idMatch[1]),
      title: header[1].trim(),
      excerpt: cleanExcerpt(rest, excerptChars),
      tags: parseTags(block),
      similarity: Number(header[2]),
    });
  }
  return entries;
}

/**
 * Session transcripts share one vector table with curated entries, so a
 * semantic search returns both. Transcript rows carry a `session:N` tag.
 */
export function isTranscript(entry: KbEntry): boolean {
  return entry.tags.some((tag) => tag.startsWith("session:"));
}

/**
 * The keyword search matches title and content alike and returns them in
 * insertion order, so an entry that merely mentions the project can outrank the
 * project's own rolling entry. Reorder by how strongly each hit is *about* the
 * project before the list gets truncated.
 */
export function rankProjectEntries(entries: KbEntry[], projectName: string): KbEntry[] {
  const needle = projectName.toLowerCase();
  const score = (entry: KbEntry): number => {
    const titleMatch = Boolean(needle) && entry.title.toLowerCase().includes(needle);
    const tagMatch = Boolean(needle) && entry.tags.some((tag) => tag.toLowerCase() === needle);
    let value = 0;
    if (titleMatch) value += 4;
    if (tagMatch) value += 1;
    // A rolling entry is the most useful thing to read first, but only when it
    // is this project's rolling entry.
    if ((titleMatch || tagMatch) && entry.tags.some((tag) => tag.toLowerCase() === "rolling")) {
      value += 2;
    }
    return value;
  };
  return entries
    .map((entry, index) => ({ entry, index, score: score(entry) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ entry }) => entry);
}

const PREAMBLE =
  "Entries from your personal knowledge base that may bear on this session. " +
  "Titles and excerpts only: call `personal-knowledge_get_knowledge` with an ID for the full entry, " +
  "`personal-knowledge_search_knowledge_text` to look for others, and treat anything here as possibly " +
  "stale until you check it against the working tree.";

export function formatContextBlock(
  projectName: string,
  projectEntries: KbEntry[],
  relatedEntries: KbEntry[],
  options: AutoMemoryOptions,
): string {
  const seen = new Set<number>();
  const lines: string[] = [];

  const project = projectEntries.slice(0, options.maxInjectEntries);
  if (project.length > 0) {
    lines.push(`\nMatching "${projectName}":`);
    for (const entry of project) {
      seen.add(entry.id);
      lines.push(`- #${entry.id} ${entry.title}${entry.excerpt ? ` — ${entry.excerpt}` : ""}`);
    }
  }

  const related = relatedEntries
    .filter((entry) => !seen.has(entry.id))
    .slice(0, options.maxInjectEntries);
  if (related.length > 0) {
    lines.push("\nPossibly relevant:");
    for (const entry of related) {
      const score = entry.similarity === undefined ? "" : ` [${entry.similarity}%]`;
      lines.push(`- #${entry.id}${score} ${entry.title}${entry.excerpt ? ` — ${entry.excerpt}` : ""}`);
    }
  }

  if (lines.length === 0) return "";
  return `<memory-context>\n${PREAMBLE}\n${lines.join("\n")}\n</memory-context>`;
}

const DEFAULT_KEYWORD_PATTERNS = [
  "remember",
  "memorize",
  "save\\s+this",
  "note\\s+this",
  "keep\\s+in\\s+mind",
  "don'?t\\s+forget",
  "store\\s+this",
  "record\\s+this",
  "make\\s+a\\s+note",
  "take\\s+note",
  "jot\\s+down",
  "запомни",
  "не\\s+забудь",
];

export function buildKeywordPattern(extra: string[]): RegExp {
  return new RegExp(`(${[...DEFAULT_KEYWORD_PATTERNS, ...extra].join("|")})`, "i");
}

/** Code and quoted spans are stripped so a code sample cannot trigger a save. */
export function hasSaveIntent(text: string, pattern: RegExp): boolean {
  const withoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  return pattern.test(withoutCode);
}

export const SAVE_NUDGE =
  "<memory-save-intent>\n" +
  "The user asked for something to be remembered. Persist it with the personal-knowledge tools " +
  "before you finish this turn: `personal-knowledge_update_knowledge` to overwrite the project's " +
  "existing rolling entry, or `personal-knowledge_store_knowledge` for a durable fact that has no " +
  "entry yet. Say which entry you wrote, so it can be corrected. Do not skip this.\n" +
  "</memory-save-intent>";
