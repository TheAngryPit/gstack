/**
 * Subprocess tests for bin/gstack-decision-trail: the TSV decision trail
 * (header once, append-only, one-line cells, spreadsheet formula guard), the
 * start-row rule and its idempotent rerun, and the --run admission check.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const BIN = path.join(ROOT, "bin", "gstack-decision-trail");
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

let tmp: string;
let file: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-decision-trail-"));
  file = path.join(tmp, "run", "decisions.tsv");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: "utf8", timeout: 20_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const rows = () => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => l.split("\t"));

describe("gstack-decision-trail append", () => {
  test("first append creates the parent directory, the header and one stamped row", () => {
    const r = run(file, "frame", "counted the work first", "size before a long run", "commit 3a9f1c2", "5 things to sort out");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`appended row 1 to ${file}\n`);
    const [header, row] = rows();
    expect(header).toEqual(["ts", "phase", "decision", "why", "evidence", "result"]);
    expect(row!.slice(1)).toEqual(["frame", "counted the work first", "size before a long run", "commit 3a9f1c2", "5 things to sort out"]);
    expect(row![0]).toMatch(TS_RE);
  });

  test("later appends add rows and never a second header; an empty existing file gets the header", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    run(file, "a", "b", "c", "d", "e");
    run(file, "f", "g", "h", "i", "j");
    const all = rows();
    expect(all).toHaveLength(3);
    expect(all.filter(r => r[0] === "ts")).toHaveLength(1);
    expect(all[2]!.slice(1)).toEqual(["f", "g", "h", "i", "j"]);
  });

  test("cells lose tabs and line breaks, and a leading =, +, - or @ gets a quote so a spreadsheet cannot run it", () => {
    run(file, "probe", "=HYPERLINK(\"http://evil\")", "two\nlines\there\r", "-", "@SUM(A1)");
    const row = rows()[1]!;
    expect(row).toHaveLength(6);
    expect(row.slice(1)).toEqual(["probe", "'=HYPERLINK(\"http://evil\")", "two lines here ", "'-", "'@SUM(A1)"]);
    run(file, "+1", "plain", "plain", "plain", "plain");
    expect(rows()[2]![1]).toBe("'+1");
  });

  test("a cell equal to -h or --help is data, a trail without a final newline or with CRLF rows is repaired on append, and a repeated header is never a row", () => {
    const r = run(file, "phase", "--help", "why", "evidence", "-h");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`appended row 1 to ${file}\n`);
    expect(rows()[1]!.slice(1)).toEqual(["phase", "'--help", "why", "evidence", "'-h"]);
    fs.appendFileSync(file, "x\ty\tz");
    run(file, "p2", "d2", "w", "e", "r");
    const all = rows();
    expect(all[2]).toEqual(["x", "y", "z"]);
    expect(all[3]!.slice(1)).toEqual(["p2", "d2", "w", "e", "r"]);
    const crlf = path.join(tmp, "crlf.tsv");
    fs.writeFileSync(crlf, "ts\tphase\tdecision\twhy\tevidence\tresult\r\n2026-01-01T00:00:00Z\ta\tb\tc\td\te\r\nts\tphase\tdecision\twhy\tevidence\tresult\r\n");
    const start = run("start", crlf, "run-1");
    expect(start.stdout).toBe(`appended start row 2 for run run-1 to ${crlf}\n`);
    expect(fs.readFileSync(crlf, "utf8").split("\n").filter(Boolean).pop()!.split("\t")[3]).toBe("1 earlier row (2026-01-01T00:00:00Z..2026-01-01T00:00:00Z) written by other runs");
  });

  test("a blank file gets a header, and a BOM before the header does not make it a row", () => {
    const blank = path.join(tmp, "blank.tsv");
    fs.writeFileSync(blank, "\n");
    expect(run(blank, "p", "d", "w", "e", "r").status).toBe(0);
    expect(run(blank, "p2", "d", "w", "e", "r").status).toBe(0);
    const lines = fs.readFileSync(blank, "utf8").split("\n");
    expect(lines[1]).toBe("ts\tphase\tdecision\twhy\tevidence\tresult");
    expect(lines[2]!.split("\t").slice(1)).toEqual(["p", "d", "w", "e", "r"]);
    expect(lines.filter(l => l === "ts\tphase\tdecision\twhy\tevidence\tresult")).toHaveLength(1);
    const bom = path.join(tmp, "bom.tsv");
    fs.writeFileSync(bom, "\uFEFFts\tphase\tdecision\twhy\tevidence\tresult\n");
    expect(run("--run", "r1", bom, "p", "d", "w", "e", "r").status).toBe(0);
    expect(fs.readFileSync(bom, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  test("a run id with whitespace or quotes is a usage error on start and on --run", () => {
    expect(run("start", file, "a\tb").status).toBe(2);
    expect(run("start", file, "a b").status).toBe(2);
    expect(run("--run", "x'y", file, "a", "b", "c", "d", "e").status).toBe(2);
    expect(run("start", file, "jam_01ABC.turn-2:x/y@z").status).toBe(0);
    expect(fs.readFileSync(file, "utf8").split("\n")).toHaveLength(3);
  });

  test("wrong arity, an unknown option and a bare call are usage errors; --help exits 0", () => {
    expect(run(file, "only", "four", "cells", "here").status).toBe(2);
    expect(run("--bogus", file, "a", "b", "c", "d", "e").status).toBe(2);
    expect(run().status).toBe(2);
    expect(run(file, "start", "a", "b", "c", "d").status).toBe(2);
    const help = run("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("gstack-decision-trail start <file> <run-id>");
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("gstack-decision-trail start", () => {
  test("a start row names the earlier rows and the run; rerunning it for the same run is a no-op", () => {
    run(file, "a", "b", "c", "d", "e");
    run(file, "f", "g", "h", "i", "j");
    const first = run("start", file, "jam_A");
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(`appended start row 3 for run jam_A to ${file}\n`);
    const start = rows()[3]!;
    expect(start[1]).toBe("start");
    expect(start[2]).toBe("run jam_A joins this trail");
    expect(start[3]).toMatch(/^2 earlier rows \(\d{4}-.*\.\.\d{4}-.*\) written by other runs$/);
    expect(start[4]).toBe("run:jam_A");
    expect(start[5]).toBe("open");

    const again = run("start", file, "jam_A");
    expect(again.status).toBe(0);
    expect(again.stdout).toBe(`start row for run jam_A already present at ${file}:4\n`);
    expect(rows()).toHaveLength(4);
  });

  test("a start row on an empty trail opens it, and another run's start row follows a prior run's", () => {
    expect(run("start", file, "run-1").stdout).toBe(`appended start row 1 for run run-1 to ${file}\n`);
    expect(rows()[1]!.slice(1)).toEqual(["start", "run run-1 opens this trail", "no earlier rows", "run:run-1", "open"]);
    run("--run", "run-1", file, "work", "did a thing", "because", "commit 1", "ok");
    expect(run("start", file, "run-2").status).toBe(0);
    expect(rows().map(r => r[1])).toEqual(["phase", "start", "work", "start"]);
    // run-1's row is older than run-2's start, so run-1 is a new run again and needs a new start row.
    expect(run("start", file, "run-1").stdout).toContain("appended start row 4");
  });

  test("--run refuses an append until the run's start row is the newest one, and admits a fresh trail", () => {
    expect(run("--run", "r9", file, "a", "b", "c", "d", "e").status).toBe(0);
    run("start", file, "other");
    const refused = run("--run", "r9", file, "a", "b", "c", "d", "e");
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("DECISION_TRAIL_START_REQUIRED");
    expect(refused.stderr).toContain(`gstack-decision-trail start ${file} r9`);
    expect(rows()).toHaveLength(3);
    run("start", file, "r9");
    expect(run("--run", "r9", file, "a", "b", "c", "d", "e").status).toBe(0);
    expect(rows()).toHaveLength(5);
  });

  test("start with the wrong arity is a usage error", () => {
    expect(run("start", file).status).toBe(2);
    expect(run("start", file, "r", "extra").status).toBe(2);
  });
});
