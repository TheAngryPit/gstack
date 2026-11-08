/**
 * Fixture test for bin/gstack-worktree-audit: a bare origin, a main clone and
 * worktrees in every bucket the script knows, with a fake gh on PATH and a
 * Claude Code transcript directory under CLAUDE_CONFIG_DIR. The audit reads
 * only: the fixture is byte-compared before and after.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const BIN = path.join(ROOT, "bin", "gstack-worktree-audit");

let tmp: string;
let repo: string;
let origin: string;
let fakeBin: string;
let claudeDir: string;
const wts: Record<string, string> = {};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(cwd: string, file: string, text: string, msg: string): void {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", msg);
}
function audit(...args: string[]) {
  const r = spawnSync("bash", [BIN, ...args], {
    cwd: repo, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: claudeDir, HOME: tmp },
  });
  const lines = r.stdout.split("\n").filter(Boolean);
  const header = lines[1]?.split("\t") ?? [];
  const rows = lines.slice(2).map(l => Object.fromEntries(l.split("\t").map((v, i) => [header[i]!, v])) as Record<string, string>);
  return { status: r.status, stderr: r.stderr, base: lines[0], header, rows, byPath: Object.fromEntries(rows.map(r => [r.WORKTREE, r])) };
}
function snapshot(dir: string): string {
  const r = spawnSync("bash", ["-c", "find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum; git -C . status --porcelain; git -C . for-each-ref; git -C . worktree list --porcelain"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
  return r.stdout;
}
// The fake gh records its argv and, when jq is installed, runs the audit's own --jq expression over
// canned JSON (so the fork-PR filter is exercised); without jq it prints the TSV that expression yields.
function fakeGh(prs: Array<{ number: number; state: string; headRefName: string; isCrossRepository: boolean }>): void {
  fs.writeFileSync(path.join(fakeBin, "prs.json"), JSON.stringify(prs));
  fs.writeFileSync(path.join(fakeBin, "prs.tsv"), prs.filter(p => !p.isCrossRepository).map(p => `${p.headRefName}\t${p.number}\t${p.state.toLowerCase()}`).join("\n") + "\n");
  fs.writeFileSync(path.join(fakeBin, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${fakeBin}/gh-args"
expr=""; while [ $# -gt 0 ]; do [ "$1" = --jq ] && expr="$2"; shift; done
if command -v jq >/dev/null 2>&1 && [ -n "$expr" ]; then jq -r "$expr" "${fakeBin}/prs.json"; else cat "${fakeBin}/prs.tsv"; fi
`, { mode: 0o755 });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-wt-audit-"));
  origin = path.join(tmp, "origin.git");
  repo = path.join(tmp, "repo");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "--initial-branch=main");
  git(tmp, "clone", "-q", origin, repo);
  git(repo, "checkout", "-q", "-b", "main");
  commit(repo, "README.md", "# fixture\n", "initial");
  git(repo, "push", "-q", "-u", "origin", "main");

  // merged: a branch whose commit was fast-forwarded into main and pushed; clean tree, branch never pushed.
  wts.merged = path.join(tmp, "wt-merged");
  git(repo, "worktree", "add", "-q", "-b", "feat/merged", wts.merged);
  commit(wts.merged, "merged.txt", "done\n", "merged work");
  git(repo, "merge", "-q", "--ff-only", "feat/merged");
  git(repo, "push", "-q", "origin", "main");

  // wip: pushed branch with a tracked edit on top; its PR is open.
  wts.wip = path.join(tmp, "wt-wip");
  git(repo, "worktree", "add", "-q", "-b", "feat/wip", wts.wip);
  commit(wts.wip, "wip.txt", "v1\n", "wip work");
  git(wts.wip, "push", "-q", "-u", "origin", "feat/wip");
  fs.writeFileSync(path.join(wts.wip, "wip.txt"), "v2 edited\n");

  // scratch: an unpushed branch, two untracked files, a chat from today → verify-recent-chat.
  wts.scratch = path.join(tmp, "wt-scratch");
  git(repo, "worktree", "add", "-q", "-b", "feat/scratch", wts.scratch);
  commit(wts.scratch, "scratch.txt", "s\n", "scratch work");
  fs.writeFileSync(path.join(wts.scratch, "notes.md"), "untracked\n");
  fs.writeFileSync(path.join(wts.scratch, "tmp.log"), "untracked\n");
  claudeDir = path.join(tmp, "claude");
  const chat = path.join(claudeDir, "projects", wts.scratch.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(chat, { recursive: true });
  fs.writeFileSync(path.join(chat, "session.jsonl"), "{}\n");

  // stale: an unpushed branch nobody touched, no chat, no PR → review.
  wts.stale = path.join(tmp, "wt-stale");
  git(repo, "worktree", "add", "-q", "-b", "feat/stale", wts.stale);
  commit(wts.stale, "stale.txt", "s\n", "stale work");

  // closed: pushed branch whose PR was closed without merging → safe.
  wts.closed = path.join(tmp, "wt-closed");
  git(repo, "worktree", "add", "-q", "-b", "feat/closed", wts.closed);
  commit(wts.closed, "closed.txt", "c\n", "closed work");
  git(wts.closed, "push", "-q", "-u", "origin", "feat/closed");

  fakeBin = path.join(tmp, "fakebin");
  fs.mkdirSync(fakeBin);

  // spaced: a worktree whose path has a space, merged into main, clean → safe.
  wts.spaced = path.join(tmp, "wt with space");
  git(repo, "worktree", "add", "-q", "-b", "feat/spaced", wts.spaced);
  commit(wts.spaced, "spaced.txt", "s\n", "spaced work");
  git(repo, "merge", "-q", "--ff-only", "feat/spaced");
  git(repo, "push", "-q", "origin", "main");

  // fresh: head is in main but an untracked file exists only here → review, not safe.
  wts.fresh = path.join(tmp, "wt-fresh");
  git(repo, "worktree", "add", "-q", "-b", "feat/fresh", wts.fresh);
  fs.writeFileSync(path.join(wts.fresh, "newfeature.ts"), "export const x = 1;\n");

  // gone: registered, directory deleted → prunable.
  wts.gone = path.join(tmp, "wt-gone");
  git(repo, "worktree", "add", "-q", "-b", "feat/gone", wts.gone);
  fs.rmSync(wts.gone, { recursive: true, force: true });

  // locked: registered and locked, directory gone → review (prune would not touch it).
  wts.locked = path.join(tmp, "wt-locked");
  git(repo, "worktree", "add", "-q", "-b", "feat/locked", wts.locked);
  git(repo, "worktree", "lock", wts.locked);
  fs.rmSync(wts.locked, { recursive: true, force: true });

  // broken: a gitignored worktree inside the clone whose .git file is gone, with a
  // precious file only there; git -C would describe the clone itself → review.
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".wt\n");
  wts.broken = path.join(repo, ".wt", "broken");
  git(repo, "worktree", "add", "-q", "-b", "feat/broken", wts.broken);
  fs.writeFileSync(path.join(wts.broken, "precious.txt"), "only here\n");
  fs.rmSync(path.join(wts.broken, ".git"));

  // tagged: merged and clean, with a tag of the same name as its branch and an open PR → hold-open-pr.
  wts.tagged = path.join(tmp, "wt-tagged");
  git(repo, "worktree", "add", "-q", "-b", "feat/tagged", wts.tagged);
  git(repo, "tag", "feat/tagged");

  // ignored: merged and clean, with a gitignored .env → safe, DIRTY names the ignored entry.
  wts.ignored = path.join(tmp, "wt-ignored");
  git(repo, "worktree", "add", "-q", "-b", "feat/ignored", wts.ignored);
  fs.writeFileSync(path.join(wts.ignored, ".gitignore"), ".env\n");
  git(wts.ignored, "add", ".gitignore");
  git(wts.ignored, "commit", "-q", "-m", "ignore .env");
  git(repo, "merge", "-q", "--ff-only", "feat/ignored");
  git(repo, "push", "-q", "origin", "main");
  fs.writeFileSync(path.join(wts.ignored, ".env"), "SECRET=1\n");
});
// Each test starts from the same gh (one open, one closed, one fork PR on feat/stale that must be
// ignored) and the same closed worktree, whatever an earlier test changed.
beforeEach(() => {
  fakeGh([
    { number: 41, state: "OPEN", headRefName: "feat/wip", isCrossRepository: false },
    { number: 40, state: "CLOSED", headRefName: "feat/closed", isCrossRepository: false },
    { number: 99, state: "OPEN", headRefName: "feat/stale", isCrossRepository: true },
    { number: 43, state: "OPEN", headRefName: "feat/tagged", isCrossRepository: false },
  ]);
  git(wts.closed, "reset", "-q", "--hard", "origin/feat/closed");
});
afterAll(() => {
  if (repo) spawnSync("git", ["worktree", "prune"], { cwd: repo, timeout: 30_000 });
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("gstack-worktree-audit", () => {
  test("classifies every worktree, reads the PR column through gh, the chat through CLAUDE_CONFIG_DIR, and changes nothing", () => {
    const live = Object.values(wts).filter(w => fs.existsSync(w));
    const before = live.map(snapshot).join("\n") + snapshot(repo);
    const r = audit();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("warn: no -b given; MERGED checks against origin/main");
    expect(r.base).toBe("# base: origin/main");
    expect(r.header).toEqual(["SIZE", "AGE", "MERGED", "DIRTY", "REMOTE", "PR", "LAST_CHAT", "BUCKET", "WORKTREE"]);
    expect(r.rows).toHaveLength(12);
    expect(r.byPath[repo]).toBeUndefined();
    expect(r.byPath[wts.locked]).toMatchObject({ SIZE: "0", DIRTY: "missing", BUCKET: "review" });
    expect(r.byPath[wts.broken]).toMatchObject({ DIRTY: "broken", BUCKET: "review" });
    expect(r.byPath[wts.tagged]).toMatchObject({ MERGED: "YES", DIRTY: "clean", PR: "#43/open", BUCKET: "hold-open-pr" });
    expect(r.byPath[wts.ignored]).toMatchObject({ MERGED: "YES", DIRTY: "clean,ignored:1", BUCKET: "safe" });
    const ghArgs = fs.readFileSync(path.join(fakeBin, "gh-args"), "utf8").split("\n");
    expect(ghArgs).toContain("number,state,headRefName,isCrossRepository");
    expect(ghArgs.find(a => a.startsWith(".[]"))).toContain("select(.isCrossRepository | not)");
    expect(r.byPath[wts.spaced]).toMatchObject({ MERGED: "YES", DIRTY: "clean", BUCKET: "safe" });
    expect(r.byPath[wts.fresh]).toMatchObject({ MERGED: "YES", DIRTY: "scratch:1", REMOTE: "no-remote", BUCKET: "review" });
    expect(r.byPath[wts.gone]).toMatchObject({ SIZE: "0", DIRTY: "missing", BUCKET: "prunable" });
    expect(r.rows.slice(-2).map(row => row.WORKTREE).sort()).toEqual([wts.gone, wts.locked].sort());

    const merged = r.byPath[wts.merged]!;
    expect(merged).toMatchObject({ MERGED: "YES", DIRTY: "clean", REMOTE: "no-remote", PR: "-", LAST_CHAT: "-", BUCKET: "safe", AGE: "0d" });
    expect(merged.SIZE).toMatch(/^\d+(\.\d+)?[KMG]?$/);

    expect(r.byPath[wts.wip]).toMatchObject({ MERGED: "no", DIRTY: "wip:1", REMOTE: "pushed", PR: "#41/open", BUCKET: "hold-wip" });
    const scratch = r.byPath[wts.scratch]!;
    expect(scratch).toMatchObject({ MERGED: "no", DIRTY: "scratch:2", REMOTE: "no-remote", PR: "-", BUCKET: "verify-recent-chat" });
    expect(scratch.LAST_CHAT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.byPath[wts.stale]).toMatchObject({ MERGED: "no", DIRTY: "clean", REMOTE: "no-remote", PR: "-", LAST_CHAT: "-", BUCKET: "review" });
    expect(r.byPath[wts.closed]).toMatchObject({ MERGED: "no", DIRTY: "clean", REMOTE: "pushed", PR: "#40/closed", BUCKET: "safe" });

    const after = live.map(snapshot).join("\n") + snapshot(repo);
    expect(after).toBe(before);
  });

  test("status.showUntrackedFiles=no in the user's config does not hide untracked files", () => {
    const r = spawnSync("bash", [BIN, "--no-fetch"], {
      cwd: repo, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: claudeDir, HOME: tmp, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "status.showUntrackedFiles", GIT_CONFIG_VALUE_0: "no" },
    });
    expect(r.status).toBe(0);
    const row = r.stdout.split("\n").find(l => l.endsWith("\t" + wts.fresh))!;
    expect(row.split("\t").slice(3, 4)).toEqual(["scratch:1"]);
    expect(row.split("\t")[7]).toBe("review");
  });

  test("an unpushed commit on a branch with a closed PR is review, an open PR on the same name wins and holds it, and -b picks the base", () => {
    git(wts.closed, "commit", "-q", "--allow-empty", "-m", "one more");
    const r1 = audit("-b", "origin/main", "--no-fetch", repo);
    expect(r1.stderr).not.toContain("warn: no -b given");
    expect(r1.byPath[wts.closed]).toMatchObject({ REMOTE: "ahead1", PR: "#40/closed", BUCKET: "review" });
    fakeGh([
      { number: 40, state: "CLOSED", headRefName: "feat/closed", isCrossRepository: false },
      { number: 42, state: "OPEN", headRefName: "feat/closed", isCrossRepository: false },
    ]);
    const r2 = audit("-b", "origin/main", "--no-fetch", repo);
    expect(r2.byPath[wts.closed]).toMatchObject({ REMOTE: "ahead1", PR: "#42/open", BUCKET: "hold-open-pr" });
  });

  test("without gh the PR column is - with a warning, and a missing base ref or repo is an error", () => {
    // A PATH with every tool the audit uses except gh. git goes in as the real binary from its
    // exec path, since a distribution's /usr/bin/git may be a wrapper script that looks git up on PATH.
    const noGh = path.join(tmp, "nogh");
    fs.mkdirSync(noGh);
    const onPath = (tool: string) => (process.env.PATH ?? "").split(path.delimiter).map(d => path.join(d, tool)).find(p => fs.existsSync(p));
    const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 30_000 }).stdout.trim();
    const realGit = [path.join(execPath, "git"), onPath("git")].find(p => p && fs.existsSync(p))!;
    fs.symlinkSync(fs.realpathSync(realGit), path.join(noGh, "git"));
    for (const tool of ["bash", "sh", "env", "du", "awk", "sed", "sort", "head", "find", "xargs", "stat", "date", "mktemp", "grep", "rm", "cat", "dirname", "basename", "uname", "tr", "cut", "wc"]) {
      const found = onPath(tool);
      if (found) fs.symlinkSync(fs.realpathSync(found), path.join(noGh, tool));
    }
    const r = spawnSync("bash", [BIN, "--no-fetch"], { cwd: repo, encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: noGh, CLAUDE_CONFIG_DIR: claudeDir, HOME: tmp } });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("PR column is -");
    const rows = r.stdout.split("\n").filter(Boolean).slice(2);
    expect(rows).toHaveLength(12);
    expect(rows.every(l => l.split("\t")[5] === "-")).toBe(true);
    fs.writeFileSync(path.join(fakeBin, "gh"), "#!/usr/bin/env bash\necho 'gh: not logged in' >&2; exit 4\n", { mode: 0o755 });
    const failing = audit("--no-fetch");
    expect(failing.status).toBe(0);
    expect(failing.stderr).toContain("gh could not list this repository's PRs; PR column is -");
    expect(failing.rows).toHaveLength(12);
    expect(failing.rows.every(row => row.PR === "-")).toBe(true);
    expect(audit("-b", "origin/nope", "--no-fetch").status).toBe(1);
    expect(audit("--no-fetch", path.join(tmp, "not-a-repo")).status).toBe(1);
    expect(audit("--bogus").status).toBe(2);
    expect(audit("--help").status).toBe(0);
  });
});
