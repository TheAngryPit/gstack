import { describe, test, expect, afterEach } from "bun:test";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
import {
  detectAutopilot,
  decideSourceRemove,
  decideCodeSync,
  isInside,
  _resetCapabilityMemo,
  type GbrainSourceRow,
} from "../lib/gbrain-guards";

const HOME = os.homedir();
const clonesPath = (name: string) => join(HOME, ".gbrain", "clones", name);

afterEach(() => _resetCapabilityMemo());

// ── #1734 autopilot detection (E1: affirmative multi-signal) ────────────────
describe("detectAutopilot", () => {
  test("refuses on a present lock file (secondary signal)", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, "");
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(true);
    expect(r.signal).toContain("lock:");
  });

  test("refuses on a live autopilot process (primary signal)", () => {
    const r = detectAutopilot(process.env, { lockPaths: [], processRunning: () => true });
    expect(r.active).toBe(true);
    expect(r.signal).toBe("process:gbrain autopilot");
  });

  test("proceeds when no signal fires (never blanket-refuses)", () => {
    const r = detectAutopilot(process.env, { lockPaths: [], processRunning: () => false });
    expect(r.active).toBe(false);
    expect(r.signal).toBeNull();
  });

  // Stale-lock self-heal: a crashed daemon's lock (dead holder pid) must NOT
  // wedge syncs forever (observed: dead pid refused --full indefinitely).
  const DEAD_PID = 2999999; // above macOS pid_max; vanishingly unlikely elsewhere

  test("ignores a STALE lock whose holder pid is dead", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, `${DEAD_PID}\n`);
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(false);
    expect(r.signal).toBeNull();
  });

  test("treats a FRESH lock (live holder pid) as active", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, String(process.pid)); // the test runner itself is alive
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(true);
    expect(r.signal).toContain(`pid ${process.pid}`);
  });

  test("parses a JSON lock body and ignores it when the pid is dead", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, started_at: "x" }));
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(false);
  });

  test("a stale lock does not mask a live autopilot process", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, `${DEAD_PID}`);
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => true });
    expect(r.active).toBe(true);
    expect(r.signal).toBe("process:gbrain autopilot");
  });

  // #3360: the probe stays machine-wide; the refusal names whose autopilot it is.
  test("a matched autopilot process is named by pid and command, with how to proceed", () => {
    const r = detectAutopilot(process.env, {
      lockPaths: [],
      processRunning: () => [{ pid: 4242, command: "gbrain autopilot --repo /src/other-brain" }],
    });
    expect(r.active).toBe(true);
    expect(r.signal).toBe(
      "process:gbrain autopilot pid 4242 `gbrain autopilot --repo /src/other-brain`; this check counts any process on this machine " +
        "whose command line contains \"gbrain autopilot\", even an autopilot serving another brain or repo. Stop that autopilot " +
        "(or its service, if `gbrain autopilot --install` set one up), or end the process that only mentions it",
    );
  });

  test("every matched autopilot process is listed", () => {
    const r = detectAutopilot(process.env, {
      lockPaths: [],
      processRunning: () => [
        { pid: 4242, command: "gbrain autopilot --repo /a" },
        { pid: 4343, command: "gbrain autopilot --repo /b" },
      ],
    });
    expect(r.signal).toContain("pid 4242 `gbrain autopilot --repo /a`, pid 4343 `gbrain autopilot --repo /b`;");
  });

  test("no matched process is inactive", () => {
    const r = detectAutopilot(process.env, { lockPaths: [], processRunning: () => [] });
    expect(r).toEqual({ active: false, signal: null });
  });

  test.skipIf(process.platform === "win32")("the real probe names a live process anywhere on the machine, credentials masked", async () => {
    const url = ["postgres://u", "hunter2@h/db"].join(":");
    const child = spawn(process.execPath, ["-e", "console.log('ready'); setTimeout(() => {}, 30000)", `gbrain autopilot --repo /tmp/gstack-3360 --db ${url}`], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise(resolve => child.stdout!.once("data", resolve));
      const r = detectAutopilot(process.env, { lockPaths: [] });
      expect(r.active).toBe(true);
      expect(r.signal).toContain(`pid ${child.pid} \``);
      expect(r.signal).toContain("gbrain autopilot --repo /tmp/gstack-3360 --db postgres://***@h/db");
      expect(r.signal).not.toContain("hunter2");
      expect(r.signal).toContain("Stop that autopilot");
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("a lock with no parseable pid stays conservative (active, no pid in signal)", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, "corrupted-no-pid-here");
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(true); // can't introspect → don't ignore the lock
    expect(r.signal).toContain("lock:");
    expect(r.signal).not.toContain("pid");
  });
});

// ── #1734 remove safety (E7: fail closed on user-managed without keep-storage) ─
describe("decideSourceRemove", () => {
  const rows = (extra: GbrainSourceRow[] = []): GbrainSourceRow[] => [
    { id: "gbrain-managed", local_path: clonesPath("repo"), config: { remote_url: "https://x/r.git" } },
    { id: "user-managed", local_path: "/tmp/user-repo", config: { remote_url: "https://x/r.git" } },
    { id: "path-managed", local_path: "/tmp/path-repo" }, // no remote_url
    ...extra,
  ];
  const fetchRows = (extra?: GbrainSourceRow[]) => () => rows(extra);

  test("absent source → allow (no-op)", () => {
    const d = decideSourceRemove("nope", process.env, { keepStorage: false, fetchRows: fetchRows() });
    expect(d.allow).toBe(true);
    expect(d.reason).toContain("absent");
  });

  test("user-managed + no --keep-storage → FAIL CLOSED", () => {
    const d = decideSourceRemove("user-managed", process.env, { keepStorage: false, fetchRows: fetchRows() });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("user-managed");
  });

  test("user-managed + --keep-storage supported → allow with flag", () => {
    const d = decideSourceRemove("user-managed", process.env, { keepStorage: true, fetchRows: fetchRows() });
    expect(d.allow).toBe(true);
    expect(d.extraArgs).toContain("--keep-storage");
  });

  test("gbrain-managed (inside clones) → allow even without keep-storage", () => {
    const d = decideSourceRemove("gbrain-managed", process.env, { keepStorage: false, fetchRows: fetchRows() });
    expect(d.allow).toBe(true);
  });

  test("path-managed without remote_url → allow (normal --path case)", () => {
    const d = decideSourceRemove("path-managed", process.env, { keepStorage: false, fetchRows: fetchRows() });
    expect(d.allow).toBe(true);
  });

  test("sources unreadable → FAIL CLOSED", () => {
    const d = decideSourceRemove("user-managed", process.env, {
      keepStorage: false,
      fetchRows: () => { throw new Error("boom"); },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("fail closed");
  });
});

// ── #1734 reclone guard (E-level: require --allow-reclone for URL-managed) ───
describe("decideCodeSync", () => {
  const rows: GbrainSourceRow[] = [
    { id: "url-managed", local_path: "/tmp/u", config: { remote_url: "https://x/r.git" } },
    { id: "plain", local_path: "/tmp/p" },
  ];
  const fetch = () => rows;

  test("URL-managed + no --allow-reclone → refuse", () => {
    const d = decideCodeSync("url-managed", process.env, false, fetch);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("auto-reclone");
  });

  test("URL-managed + --allow-reclone → allow", () => {
    const d = decideCodeSync("url-managed", process.env, true, fetch);
    expect(d.allow).toBe(true);
  });

  test("no remote_url → allow", () => {
    const d = decideCodeSync("plain", process.env, false, fetch);
    expect(d.allow).toBe(true);
  });

  test("sources unreadable → fail OPEN (sync read is non-destructive)", () => {
    const d = decideCodeSync("url-managed", process.env, false, () => { throw new Error("boom"); });
    expect(d.allow).toBe(true);
  });
});

// ── path containment uses realpath (symlink can't smuggle a delete out) ──────
describe("isInside", () => {
  test("plain path inside dir", () => {
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/x", "/a/b")).toBe(false);
  });

  test("sibling-prefix is not 'inside' (clonesX vs clones)", () => {
    expect(isInside("/a/clones-evil/x", "/a/clones")).toBe(false);
  });

  test("symlink pointing outside resolves outside", () => {
    const base = fs.mkdtempSync(join(os.tmpdir(), "clones-"));
    const outside = fs.mkdtempSync(join(os.tmpdir(), "outside-"));
    const link = join(base, "sneaky");
    fs.symlinkSync(outside, link);
    // link lives under base, but realpath resolves to `outside` → not inside base.
    expect(isInside(link, base)).toBe(false);
  });
});
