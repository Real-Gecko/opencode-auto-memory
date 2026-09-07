import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";

import { serverCwd, type AutoMemoryOptions } from "./config.ts";
import { dbg, dbgAwait } from "./logger.ts";

interface Pending {
  resolve: (value: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcResponse {
  id?: number;
  error?: { message?: string };
  result?: { content?: Array<{ text?: string }> };
}

export class MCPClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending = new Map<number, Pending>();
  private nextId = 1;
  dead = false;

  constructor(private options: AutoMemoryOptions) {}

  async start(): Promise<void> {
    dbg(`MCP: spawning ${this.options.serverCommand}`);
    const cwd = serverCwd();
    mkdirSync(cwd, { recursive: true });
    this.proc = spawn(this.options.serverCommand, [], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    dbg(`MCP: spawned pid=${this.proc.pid}`);

    try {
      this.proc.stderr.on("data", () => {});
    } catch {
      // stderr is not essential.
    }

    this.proc.on("exit", (code) => {
      dbg(`MCP: process exited code=${code}`);
      this.dead = true;
      for (const [id, { reject, timer }] of this.pending) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("MCP server exited"));
      }
      if (current === this) {
        current = null;
        starting = null;
      }
    });
    this.proc.on("error", (error: Error) => dbg(`MCP: spawn error ${error?.message}`));

    this.startReadLoop();

    await dbgAwait(
      "MCP.initialize",
      this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "opencode-auto-memory", version: "1.0.0" },
      }),
    );
    dbg("MCP: initialized");
    await this.notify("notifications/initialized", {});
    dbg("MCP: initialized notification sent");
  }

  private startReadLoop(): void {
    const stdout = this.proc?.stdout;
    if (!stdout) return;
    const decoder = new TextDecoder();

    const onChunk = (value: Uint8Array) => {
      this.buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        try {
          this.handle(JSON.parse(line) as JsonRpcResponse);
        } catch (error) {
          dbg(
            `MCP: bad JSON line dropped: ${line.slice(0, 200)} err=${(error as Error)?.message}`,
          );
        }
      }
    };

    try {
      stdout.on("data", onChunk);
      stdout.on("error", (error: Error) => dbg(`MCP: stdout error ${error?.message}`));
    } catch (error) {
      dbg(`MCP: read loop error: ${(error as Error)?.message}`);
    }
  }

  private handle(message: JsonRpcResponse): void {
    if (message.id === undefined) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message ?? "MCP error"));
    else entry.resolve(message);
  }

  private send(payload: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin || typeof stdin.write !== "function") throw new Error("MCP stdin not writable");
    stdin.write(new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
  }

  private request(method: string, params: unknown): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${this.options.requestTimeoutMs}ms`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const response = await this.request("tools/call", { name, arguments: args });
    const content = response.result?.content;
    if (Array.isArray(content) && typeof content[0]?.text === "string") return content[0].text;
    return "";
  }

  close(): void {
    try {
      this.proc?.kill();
    } catch {
      // Already gone.
    }
  }
}

let current: MCPClient | null = null;
let starting: Promise<MCPClient> | null = null;

export async function getMcp(options: AutoMemoryOptions): Promise<MCPClient> {
  if (current?.dead) {
    current = null;
    starting = null;
  }
  if (current) return current;
  if (!starting) {
    starting = (async () => {
      const client = new MCPClient(options);
      await client.start();
      current = client;
      return client;
    })().catch((error: Error) => {
      dbg(`MCP: getMcp failed: ${error?.message}`);
      throw error;
    });
  }
  try {
    return await starting;
  } catch (error) {
    starting = null;
    throw error;
  }
}

export function closeMcp(): void {
  current?.close();
}
