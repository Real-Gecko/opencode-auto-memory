import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The state path is resolved per call from AUTO_MEMORY_STATE_PATH, so tests
// never touch the real file. Do NOT switch this to overriding $HOME: bun
// resolves os.homedir() once at startup and ignores later assignment, which is
// how an earlier version of this test truncated the live state file.
const dir = mkdtempSync(join(tmpdir(), "auto-memory-state-"));
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "auto-memory.json");
process.env.AUTO_MEMORY_STATE_PATH = statePath;

const config = await import("../src/config.ts");
const { commitSession, forgetSession, loadState, saveState } = await import("../src/state.ts");

describe("state", () => {
  beforeAll(() => {
    // Guard: refuse to run if the redirect did not take, so a regression here
    // cannot destroy real state again.
    expect(config.statePath()).toBe(statePath);
    expect(statePath).toStartWith(tmpdir());
    saveState({ sessions: {} });
  });

  test("the state path is redirected away from the real file", () => {
    expect(config.statePath()).not.toContain(".config/opencode/auto-memory.json");
  });

  test("stores a fresh session", () => {
    commitSession("ses_A", { kbSessionID: 10, logged: ["m1"], name: "A" });
    expect(loadState().sessions.ses_A).toEqual({ kbSessionID: 10, logged: ["m1"], name: "A" });
  });

  test("accumulates ids across incremental persists", () => {
    commitSession("ses_A", { kbSessionID: 10, logged: ["m1", "m2"], name: "A" });
    expect(loadState().sessions.ses_A?.logged).toEqual(["m1", "m2"]);
  });

  test("keeps a session written by another process", () => {
    const state = loadState();
    state.sessions.ses_B = { kbSessionID: 99, logged: ["z1"], name: "B" };
    saveState(state);

    commitSession("ses_A", { kbSessionID: 10, logged: ["m3"], name: "A" });
    expect(loadState().sessions.ses_B?.kbSessionID).toBe(99);
  });

  test("merges ids another process appended to our session", () => {
    const state = loadState();
    state.sessions.ses_A = { kbSessionID: 10, logged: ["m1", "foreign"], name: "A" };
    saveState(state);

    commitSession("ses_A", { kbSessionID: 10, logged: ["m4"], name: "A" });
    const logged = loadState().sessions.ses_A?.logged ?? [];
    expect(logged).toContain("foreign");
    expect(logged).toContain("m4");
  });

  test("deduplicates ids", () => {
    commitSession("ses_A", { kbSessionID: 10, logged: ["m4", "m4"], name: "A" });
    const logged = loadState().sessions.ses_A?.logged ?? [];
    expect(new Set(logged).size).toBe(logged.length);
  });

  test("a replacement kbSessionID wins", () => {
    commitSession("ses_A", { kbSessionID: 11, logged: ["m5"], name: "A" });
    expect(loadState().sessions.ses_A?.kbSessionID).toBe(11);
  });

  test("leaves no temp files behind", () => {
    expect(readdirSync(dir).some((name) => name.includes(".tmp."))).toBe(false);
  });

  test("a torn file reads as empty and recovers", () => {
    writeFileSync(statePath, '{"sessions": {"ses_A": {"kbSess');
    expect(loadState()).toEqual({ sessions: {} });

    commitSession("ses_A", { kbSessionID: 12, logged: ["m1"], name: "A" });
    expect(loadState().sessions.ses_A?.kbSessionID).toBe(12);
  });

  test("forgetSession removes only its own entry", () => {
    commitSession("ses_C", { kbSessionID: 20, logged: ["m1"], name: "C" });
    forgetSession("ses_A");
    const sessions = loadState().sessions;
    expect(sessions.ses_A).toBeUndefined();
    expect(sessions.ses_C?.kbSessionID).toBe(20);
  });
});
