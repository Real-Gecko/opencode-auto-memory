# opencode-auto-memory

An opencode plugin that gives the agent a memory of its own past work, stored
locally in one SQLite file. It needs no MCP server or other service.

- **Notes.** The agent stores and searches notes with the plugin's own tools:
  `memory_search`, `memory_get`, `memory_store`, `memory_update`, `memory_delete`.
- **Conversation index.** As user messages are delivered and assistant steps
  finish, each new message is added to a full-text index: its text, reasoning
  and tool calls with their arguments, never tool output. The index holds no
  message text (contentless FTS5); `session_search` returns session and message
  ids with a preview read back from opencode's own database, and `session_read`
  reads a conversation.
- **Recall.** On the first message of a session, notes about the project and notes
  sharing words with the prompt are prepended to it, so the agent starts with
  what is already known instead of asking.

Search is keyword search (SQLite FTS5 with porter stemming): `a b` needs both
words, `a OR b`, `"exact phrase"`, `prefix*`. Input that is not valid FTS5
syntax is searched as plain words instead.

## Install

Requires opencode 2.0.x (the V2 plugin API).

```sh
opencode plugin add opencode-auto-memory@3.0.0
```

That resolves the package from npm and adds it to the global configuration. Or
write the entry yourself:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": ["opencode-auto-memory@3.0.0"]
}
```

With options:

```jsonc
{
  "plugins": [
    { "package": "opencode-auto-memory@3.0.0", "options": { "maxInjectEntries": 3 } }
  ]
}
```

Restart opencode afterwards: plugins are loaded once at startup.

Installing straight from a git URL does not work — opencode installs plugins
with npm and the git dependency preparation step fails, so the package has to
come from the registry or from a local build.

### From a local checkout

For development, point the config at the package *directory*. For a directory
path, V2 looks for a root `server` entry point rather than following
`package.json` `main`; this checkout's `server.js` re-exports the built bundle.
A `file://` URL to the `.js` bundle is rejected:

```jsonc
{
  "plugins": [{ "package": "/home/you/Development/opencode-auto-memory" }]
}
```

Build first, and after every pull:

```sh
bun install
bun run build
```

Do not keep the same plugin in both the legacy `plugin` key and the `plugins`
key; the same plugin would load twice.

## Migrating from 2.x (personal-knowledge)

Version 2.x logged to the personal-knowledge MCP server. This version needs no
server and keeps everything in its own database.

1. Update the plugin and drop its old options (`backend`, `serverCommand`,
   `serverUrl`, `apiKeyFile`, `captureToolOutput`, ...): unknown options are ignored.
2. Copy the notes, from a checkout of this repository (the npm package ships
   only the bundle):

   ```sh
   bun install
   bun scripts/import-personal-knowledge.ts            # default ~/.local/share/opencode-personal-knowledge/knowledge.db
   bun scripts/import-personal-knowledge.ts /path/to/knowledge.db
   ```

   Note ids are kept, so references such as "entry #43" still resolve. A note
   whose id is already taken is skipped, so running it twice is harmless.
   `AUTO_MEMORY_DB_PATH` selects another target database.
3. Transcripts need no migration: on start the plugin indexes the conversations
   opencode already stores. Messages that exist only in personal-knowledge (from
   sessions since deleted in opencode) are not carried over.
4. Remove the `personal-knowledge` entry from `mcp.servers` once you no longer
   need it, and update any AGENTS.md text that names `personal-knowledge_*` tools.
   `~/.config/opencode/auto-memory.json` (the old logging state) is no longer read
   and can be deleted. `knowledge.db` itself is not modified.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `captureTranscripts` | `true` | Index session messages. Off keeps notes, recall and the save reminder only |
| `memoryGuide` | `true` | Add a short "how to use memory" section to the system prompt. Only sent on requests that have the memory tools |
| `messageLimit` | `32000` | Max characters indexed per message |
| `toolInputLimit` | `1000` | Max characters of a tool call's JSON input |
| `toolErrorLimit` | `200` | Max characters of a failed call's reason |
| `injectContext` | `true` | Prepend relevant notes to the first message |
| `maxInjectEntries` | `5` | Max entries per injected section |
| `injectExcerptChars` | `220` | Max characters of each excerpt |
| `keywordNudge` | `true` | Remind the agent to save when the user says "remember this" |
| `keywordPatterns` | `[]` | Extra save-intent regex sources |
| `autoRedact` | `true` | Redact obviously secret values (tokens, passwords, keys, JWTs, private key blocks, URL userinfo) before indexing |
| `debugMaxBytes` | `1048576` | Rotate the debug log past this size |

## Files

| Path | Purpose |
| --- | --- |
| `~/.local/share/opencode-auto-memory/memory.db` | Notes and the conversation index (SQLite, WAL) |
| `~/.local/share/opencode/opencode.db` | opencode's own database, read only, to show search hits |
| `~/.config/opencode/auto-memory-debug.log` | Debug log, rotated to `.log.1` |

`AUTO_MEMORY_DB_PATH`, `AUTO_MEMORY_OPENCODE_DB` and `AUTO_MEMORY_DEBUG_PATH`
override them. The tests rely on this.

## Privacy

Anything inside `<private>...</private>` is replaced with `[REDACTED]` before a
message is indexed, and a message that is nothing but a private span is not
indexed at all. Tool output is never indexed. The index stores no text, but
`session_read` shows opencode's stored messages as they are.

On top of that, `autoRedact` (on by default) redacts values that obviously look
like secrets even when the model forgot to mark them: values following a
secret-like name (`token`, `password`, `api_key`, `client_secret`, ...), bearer
tokens, JWTs, private key blocks, and credentials embedded in a URL
(`scheme://user:pass@host`, where the scheme and host are kept). Detection is
deliberately context-based — a bare high-entropy string (commit hash, id,
example) is left alone — so it is a safety net, not a guarantee.

## Behaviour worth knowing

- **The database is shared between processes.** Several opencode processes can
  index into the same file; a message already indexed by one is skipped by the
  others.
- **The index is a cache.** Deleting `memory.db` loses the notes, but the
  conversation index alone can be dropped by deleting the `messages` and
  `messages_fts` tables. On every start the plugin indexes whatever opencode has
  stored that the index lacks (main sessions only), in the background; the first
  run over a large history takes some seconds. A deleted session is removed from
  the index.
- **Hits are read from opencode's database.** The plugin API only exposes a
  session's context since its last compaction, so previews and `session_read`
  read `session_message` and `session_v2` directly. That is opencode's internal
  schema; `src/opencode-db.ts` is the only place that knows it.
- **Streaming messages wait.** An assistant message without a completion
  timestamp is skipped and picked up after the step completes. Capture listens
  for V2's `session.inbox.delivered`, `session.step.ended`/`failed`, and execution
  completion events; older V2 idle/status/content-update events remain supported.
- **Indexing does not block events.** Capture runs in a serial background queue.
  Repeated notifications coalesce; notifications during a capture schedule a
  fresh pass so messages arriving after its snapshot are not missed. Public
  events from other locations are ignored. Individual text deltas do not trigger
  capture.
- **Subagent sessions are skipped**, for capture and injection alike.
- **Shutdown flushes.** A one-shot `opencode run` exits before idle indexing
  finishes, so plugin cleanup drains the queue and the sessions it touched.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
```

Tests never touch the real store: they redirect the paths through the environment
variables above. Note that bun resolves `os.homedir()` once at startup and ignores
a later `process.env.HOME`, so overriding `HOME` in a test does *not* isolate it.

## License

MIT — see [LICENSE](LICENSE).
