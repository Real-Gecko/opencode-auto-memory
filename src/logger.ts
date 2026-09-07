import { renameSync, statSync, writeFileSync } from "node:fs";

import { debugPath, DEFAULTS } from "./config.ts";

let maxBytes = DEFAULTS.debugMaxBytes;

export function setLogLimit(bytes: number): void {
  maxBytes = bytes;
}

export function dbg(...args: unknown[]): void {
  try {
    const rendered = args
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ");
    const line = `[${new Date().toISOString()}] ${rendered}\n`;
    const path = debugPath();
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > maxBytes) {
      renameSync(path, `${path}.1`);
    }
    writeFileSync(path, line, { flag: "a" });
  } catch {
    // Logging must never break the plugin.
  }
}

export async function dbgAwait<T>(label: string, promise: Promise<T>): Promise<T> {
  dbg(`${label} (start)`);
  const result = await promise;
  dbg(`${label} (done)`);
  return result;
}
