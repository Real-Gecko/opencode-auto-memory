import type { Plugin } from "@opencode/plugin";

import { renderMessage, roleOf } from "./capture.ts";
import type { AutoMemoryOptions } from "./config.ts";
import {
  anyWords,
  deleteNote,
  getNote,
  searchMessages,
  searchNotes,
  sessionMessages,
  storeNote,
  updateNote,
  type Note,
} from "./db.ts";
import { readMessage, sessionTitle } from "./opencode-db.ts";

const PREVIEW_CHARS = 300;

const iso = (time: number | undefined) => (time ? new Date(time).toISOString() : "?");

function noteLine(note: Note): string {
  const tags = note.tags.length ? ` [${note.tags.join(", ")}]` : "";
  const text = note.content.replace(/\s+/g, " ").trim();
  return `#${note.id} ${note.title}${tags} — ${text.length > 200 ? `${text.slice(0, 200)}...` : text}`;
}

function fullNote(note: Note): string {
  return (
    `#${note.id} ${note.title}\n` +
    `Tags: ${note.tags.join(", ")}\n` +
    `Created: ${iso(note.created_at)}  Updated: ${iso(note.updated_at)}\n\n${note.content}`
  );
}

/** A window of the message around the first query word it contains. */
function preview(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const words = (anyWords(query).match(/"([^"]+)"/g) ?? []).map((word) => word.slice(1, -1));
  const positions = words.map((word) => lower.indexOf(word)).filter((i) => i >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - PREVIEW_CHARS / 3);
  const slice = flat.slice(start, start + PREVIEW_CHARS);
  return `${start > 0 ? "..." : ""}${slice}${start + PREVIEW_CHARS < flat.length ? "..." : ""}`;
}

const text = (content: string) => ({ content });

export function registerTools(ctx: Plugin.Context, options: AutoMemoryOptions): Promise<unknown> {
  const tools = [
    {
      name: "memory_search",
      description:
        "Search your notes by keywords (SQLite FTS5 syntax: `a b` needs both, `a OR b`, `\"exact phrase\"`, `prefix*`). " +
        "Returns ids, titles, tags and excerpts, best match first.",
      input: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Max results, default 10" },
        },
        required: ["query"],
      },
      execute: async ({ query, limit }: { query: string; limit?: number }) => {
        const notes = searchNotes(query, limit ?? 10);
        return text(notes.length ? notes.map(noteLine).join("\n") : "No notes found.");
      },
    },
    {
      name: "memory_get",
      description: "Read a note in full by id.",
      input: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
      execute: async ({ id }: { id: number }) => {
        const note = getNote(id);
        return text(note ? fullNote(note) : `Note #${id} not found.`);
      },
    },
    {
      name: "memory_store",
      description: "Store a new note. Keep it to one topic; never store secrets.",
      input: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["title", "content"],
      },
      execute: async ({ title, content, tags }: { title: string; content: string; tags?: string[] }) =>
        text(`Stored note #${storeNote(title, content, tags).id}.`),
    },
    {
      name: "memory_update",
      description: "Overwrite a note's title, content or tags by id. Omitted fields stay as they are; tags are replaced.",
      input: {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["id"],
      },
      execute: async ({ id, ...changes }: { id: number; title?: string; content?: string; tags?: string[] }) =>
        text(updateNote(id, changes) ? `Updated note #${id}.` : `Note #${id} not found.`),
    },
    {
      name: "memory_delete",
      description: "Delete a note by id.",
      input: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
      execute: async ({ id }: { id: number }) =>
        text(deleteNote(id) ? `Deleted note #${id}.` : `Note #${id} not found.`),
    },
    {
      name: "session_search",
      description:
        "Search past conversations by keywords (SQLite FTS5 syntax, as for memory_search). " +
        "Returns matching messages, best first, with session id, message id and a preview. " +
        "Read around a hit with session_read.",
      input: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Max results, default 10" },
        },
        required: ["query"],
      },
      execute: async ({ query, limit }: { query: string; limit?: number }) => {
        const hits = searchMessages(query, limit ?? 10);
        if (hits.length === 0) return text("No messages found.");
        const lines: string[] = [];
        for (const hit of hits) {
          const message = readMessage(hit.sessionID, hit.messageID);
          const body = message ? preview(renderMessage(message, options), query) : "(message no longer available)";
          lines.push(
            `- session ${hit.sessionID} "${sessionTitle(hit.sessionID)}" message ${hit.messageID} ` +
              `[${hit.role}, ${iso(hit.time)}]\n  ${body}`,
          );
        }
        return text(lines.join("\n"));
      },
    },
    {
      name: "session_read",
      description:
        "Read indexed messages of a past conversation in order: text and reasoning, tool calls without output. " +
        "Starts at messageID (or the beginning); call again from the last id shown to continue.",
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          messageID: { type: "string" },
          limit: { type: "number", description: "Max messages, default 20" },
        },
        required: ["sessionID"],
      },
      execute: async ({ sessionID, messageID, limit }: { sessionID: string; messageID?: string; limit?: number }) => {
        const all = sessionMessages(sessionID);
        if (all.length === 0) return text(`No indexed messages for session ${sessionID}.`);
        const start = Math.max(0, messageID ? all.findIndex((hit) => hit.messageID === messageID) : 0);
        const page = all.slice(start, start + (limit ?? 20));
        const blocks = [`Session ${sessionID} "${sessionTitle(sessionID)}", messages ${start + 1}-${start + page.length} of ${all.length}`];
        for (const hit of page) {
          const message = readMessage(sessionID, hit.messageID);
          const body = message ? renderMessage(message, options) : "(message no longer available)";
          blocks.push(`[${message ? roleOf(message) : hit.role}] ${hit.messageID} ${iso(hit.time)}\n${body}`);
        }
        return text(blocks.join("\n\n"));
      },
    },
  ];

  return ctx.tool.transform((editor) => {
    for (const tool of tools) {
      editor.add({ ...tool, options: { codemode: false } } as unknown as Parameters<typeof editor.add>[0]);
    }
  });
}
