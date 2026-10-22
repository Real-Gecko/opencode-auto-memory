import type { AutoMemoryOptions } from "./config.ts";
import { anyWords, searchNotes, type Note } from "./db.ts";
import { formatContextBlock, rankProjectEntries } from "./kb.ts";
import { dbg } from "./logger.ts";

/**
 * Look up notes worth putting in front of the agent before it answers the first
 * message of a session: notes about the project by name, then notes sharing
 * words with the prompt.
 */
export function buildInjection(projectName: string, query: string, options: AutoMemoryOptions): string {
  let projectEntries: Note[] = [];
  let relatedEntries: Note[] = [];

  try {
    if (projectName) {
      const phrase = `"${projectName.replace(/"/g, '""')}"`;
      projectEntries = rankProjectEntries(searchNotes(phrase, options.maxInjectEntries * 3), projectName);
      dbg(`inject: project hits=${projectEntries.length} for "${projectName}"`);
    }
    const words = anyWords(query.slice(0, 2_000));
    if (words) {
      relatedEntries = searchNotes(words, options.maxInjectEntries * 2);
      dbg(`inject: related hits=${relatedEntries.length}`);
    }
  } catch (error) {
    // Partial results are still worth injecting.
    dbg(`inject: ${(error as Error)?.message ?? error}`);
  }

  return formatContextBlock(projectName, projectEntries, relatedEntries, options);
}
