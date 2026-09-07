# opencode-auto-memory

An opencode plugin that gives the agent a memory of its own past work, stored
locally.

It does two things:

- **Capture.** When a session goes idle, every new message is written to the
  [personal-knowledge](https://github.com/NocturnLabs/opencode-personal-knowledge)
  MCP store: the text of each turn plus each tool call and its arguments.
- **Recall.** On the first message of a session, knowledge-base entries that look
  relevant are prepended to the prompt as a synthetic part, so the agent starts
  with what is already known about the project instead of asking.

Everything stays on the machine. There is no API key and no third-party service;
embeddings are computed locally by the MCP server.

## Requirements

`opencode-personal-knowledge` on `PATH`. The plugin spawns it over stdio and does
not need it registered as an MCP server, though registering it too is what makes
the tools available to the agent for reading and writing entries directly.

## Install

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["file:///home/you/Development/opencode-auto-memory/dist/index.js"]
}
```

Build first, and after every pull:

```sh
bun install
bun run build
```

Restart opencode afterwards: plugins are loaded once at startup.

With options:

```jsonc
{
  "plugin": [
    [
      "file:///home/you/Development/opencode-auto-memory/dist/index.js",
      { "injectSemantic": false, "maxInjectEntries": 3 }
    ]
  ]
}
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `serverCommand` | `opencode-personal-knowledge` | Command that starts the MCP server |
| `requestTimeoutMs` | `120000` | Per-request MCP timeout; a cold embedding model is slow |
| `messageLimit` | `32000` | Max characters stored per message |
| `toolInputLimit` | `1000` | Max characters of a tool call's JSON input |
| `toolErrorLimit` | `200` | Max characters of a failed call's reason |
| `captureToolOutput` | `false` | Store tool output as well (it was 79% of the store) |
| `toolOutputLimit` | `2000` | Max characters of output when the above is on |
| `injectContext` | `true` | Prepend relevant entries to the first message |
| `injectSemantic` | `true` | Also run a semantic search, budget permitting |
| `injectTimeoutMs` | `5000` | Total budget for injection lookups |
| `maxInjectEntries` | `5` | Max entries per injected section |
| `injectExcerptChars` | `220` | Max characters of each excerpt |
| `keywordNudge` | `true` | Remind the agent to save when the user says "remember this" |
| `keywordPatterns` | `[]` | Extra save-intent regex sources |
| `debugMaxBytes` | `1048576` | Rotate the debug log past this size |

## Files

| Path | Purpose |
| --- | --- |
| `~/.config/opencode/auto-memory.json` | Which messages have been logged, and to which KB session |
| `~/.config/opencode/auto-memory-debug.log` | Debug log, rotated to `.log.1` |
| `~/.cache/opencode-personal-knowledge/` | The MCP server's working directory |

`AUTO_MEMORY_STATE_PATH`, `AUTO_MEMORY_DEBUG_PATH` and `AUTO_MEMORY_SERVER_CWD`
override the first three. The tests rely on this.

## Privacy

Anything inside `<private>...</private>` is replaced with `[REDACTED]` before a
message is stored, and a message that is nothing but a private span is not stored
at all. Output of the `personal-knowledge` tools is never stored, so a search
cannot feed its own results back into the store.

## Behaviour worth knowing

- **State is shared between processes.** Several opencode instances write the
  same state file, so every save re-reads and merges rather than overwriting, and
  writes through a temp file. Losing that file makes every session re-log its
  whole transcript into a fresh KB session.
- **Progress is saved per message.** A timed-out `log_message` used to discard a
  whole pass, which produced duplicate KB sessions.
- **The server's working directory is pinned.** `fastembed` caches a ~128MB ONNX
  model in `./local_cache` relative to its cwd, so an unpinned server leaves a
  copy in every directory opencode was started from.
- **Streaming messages wait.** An assistant message without a completion
  timestamp is skipped and picked up by the next idle.
- **Subagent sessions are skipped**, for capture and injection alike.
- **Shutdown flushes.** A one-shot `opencode run` exits before idle indexing
  finishes, so `server.instance.disposed` and `dispose` drain the sessions the
  process touched.
- **Semantic recall is best-effort.** Curated entries and logged transcripts share
  one vector index in the MCP server, so semantic hits are filtered by tag and
  the reliable lookup is the keyword one.

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

MIT
