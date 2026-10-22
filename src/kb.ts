import type { AutoMemoryOptions } from "./config.ts";
import type { Note } from "./db.ts";

function excerpt(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit).trimEnd()}...` : collapsed;
}

/**
 * The keyword search matches title, content and tags alike, so a note that
 * merely mentions the project can outrank the project's own rolling note.
 * Reorder by how strongly each hit is *about* the project before the list gets
 * truncated.
 */
export function rankProjectEntries(entries: Note[], projectName: string): Note[] {
  const needle = projectName.toLowerCase();
  const score = (entry: Note): number => {
    const titleMatch = Boolean(needle) && entry.title.toLowerCase().includes(needle);
    const tagMatch = Boolean(needle) && entry.tags.some((tag) => tag.toLowerCase() === needle);
    let value = 0;
    if (titleMatch) value += 4;
    if (tagMatch) value += 1;
    // A rolling note is the most useful thing to read first, but only when it
    // is this project's rolling note.
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
  "Notes from your memory that may bear on this session. " +
  "Titles and excerpts only: call `memory_get` with an ID for the full note, " +
  "`memory_search` to look for others, and treat anything here as possibly " +
  "stale until you check it against the working tree.";

function entryLine(entry: Note, options: AutoMemoryOptions): string {
  const text = excerpt(entry.content, options.injectExcerptChars);
  return `- #${entry.id} ${entry.title}${text ? ` — ${text}` : ""}`;
}

export function formatContextBlock(
  projectName: string,
  projectEntries: Note[],
  relatedEntries: Note[],
  options: AutoMemoryOptions,
): string {
  const seen = new Set<number>();
  const lines: string[] = [];

  const project = projectEntries.slice(0, options.maxInjectEntries);
  if (project.length > 0) {
    lines.push(`\nMatching "${projectName}":`);
    for (const entry of project) {
      seen.add(entry.id);
      lines.push(entryLine(entry, options));
    }
  }

  const related = relatedEntries
    .filter((entry) => !seen.has(entry.id))
    .slice(0, options.maxInjectEntries);
  if (related.length > 0) {
    lines.push("\nPossibly relevant:");
    for (const entry of related) lines.push(entryLine(entry, options));
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
  "The user asked for something to be remembered. Persist it before you finish this turn: " +
  "`memory_update` to overwrite the project's existing rolling note, or `memory_store` for a " +
  "durable fact that has no note yet. Say which note you wrote, so it can be corrected. Do not skip this.\n" +
  "</memory-save-intent>";

/**
 * Added to the system prompt so a model knows how to use the memory tools,
 * without the user having to write that into AGENTS.md. Describes tools only;
 * project conventions stay with the user.
 */
export const MEMORY_GUIDE =
  "## Memory\n" +
  "Persistent notes and a search index of past conversations come from the auto-memory tools. Call them directly, not through `execute`.\n" +
  "- Recall: `memory_search` (keywords, FTS5 syntax: `a b` means both, `a OR b`, `\"exact phrase\"`, `prefix*`), `memory_get` with an id for the full note.\n" +
  "- Store: `memory_store` for a new fact (title, content, tags), `memory_update` with an id to overwrite a note, `memory_delete` to remove one. Never store secrets.\n" +
  "- Past conversations: every message of the main session (text and reasoning, tool calls without their output) is indexed automatically. " +
  "Find them with `session_search`, then read one with `session_read`. Do not copy transcripts into notes.";
