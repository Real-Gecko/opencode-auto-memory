import { describe, expect, test } from "bun:test";
import { CaptureQueue } from "../src/capture-queue.ts";

describe("capture queue", () => {
  test("coalesces bursts and rechecks events received during slow capture", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const start = new Promise<void>((resolve) => { started = resolve; });
    const calls: string[] = [];
    const queue = new CaptureQueue(() => {});
    queue.enqueue("s", async () => { calls.push("superseded"); });
    queue.enqueue("s", async () => {
      calls.push("first");
      started();
      await blocked;
    });
    await start;
    queue.enqueue("s", async () => { calls.push("superseded trailing"); });
    queue.enqueue("s", async () => { calls.push("trailing"); });
    queue.enqueue("other", async () => { calls.push("other"); });
    expect(calls).toEqual(["first"]);
    release();
    await queue.drain();
    expect(calls).toEqual(["first", "trailing", "other"]);
  });

  test("continues after failure and supports subsequent drains", async () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    const queue = new CaptureQueue((error) => { errors.push(error); });
    queue.enqueue("s", async () => { throw new Error("failed"); });
    queue.enqueue("other", async () => { calls.push("other"); });
    await queue.drain();
    queue.enqueue("s", async () => { calls.push("retry"); });
    await queue.drain();
    expect(errors).toHaveLength(1);
    expect(calls).toEqual(["other", "retry"]);
  });
});
