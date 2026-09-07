import type { AutoMemoryOptions } from "./config.ts";
import {
  formatContextBlock,
  isTranscript,
  parseSemanticSearch,
  parseTextSearch,
  rankProjectEntries,
  type KbEntry,
} from "./kb.ts";
import { dbg } from "./logger.ts";
import { getMcp } from "./mcp.ts";

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error(`${label}: no time left`));
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: exceeded injection budget`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Look up knowledge entries worth putting in front of the agent before it
 * answers the first message of a session.
 *
 * Two lookups, in order of reliability. The keyword search hits sqlite directly
 * and reliably finds a project's rolling entry by name. The semantic search has
 * to wait on the embedding model and ranks curated entries against logged
 * transcripts in one index, so it is best-effort and filtered.
 *
 * Everything is bounded by one budget: injection runs inside the turn, so a cold
 * model must never hold up the user's first message.
 */
export async function buildInjection(
  projectName: string,
  query: string,
  options: AutoMemoryOptions,
): Promise<string> {
  const deadline = Date.now() + options.injectTimeoutMs;
  const remaining = () => deadline - Date.now();

  let projectEntries: KbEntry[] = [];
  let relatedEntries: KbEntry[] = [];

  try {
    const server = await withDeadline(getMcp(options), remaining(), "getMcp");

    if (projectName) {
      const text = await withDeadline(
        server.callTool("search_knowledge_text", {
          query: projectName,
          limit: options.maxInjectEntries,
        }),
        remaining(),
        "search_knowledge_text",
      );
      projectEntries = rankProjectEntries(
        parseTextSearch(text, options.injectExcerptChars),
        projectName,
      );
      dbg(`inject: keyword hits=${projectEntries.length} for "${projectName}"`);
    }

    if (options.injectSemantic && query.trim() && remaining() > 0) {
      const text = await withDeadline(
        server.callTool("search_knowledge", {
          query: query.slice(0, 2_000),
          limit: options.maxInjectEntries * 2,
        }),
        remaining(),
        "search_knowledge",
      );
      relatedEntries = parseSemanticSearch(text, options.injectExcerptChars).filter(
        (entry) => !isTranscript(entry),
      );
      dbg(`inject: semantic hits=${relatedEntries.length}`);
    }
  } catch (error) {
    // Partial results are still worth injecting.
    dbg(`inject: ${(error as Error)?.message ?? error}`);
  }

  return formatContextBlock(projectName, projectEntries, relatedEntries, options);
}
