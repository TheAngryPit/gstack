/**
 * gstack-post executable against stub gh/glab (B4). The stubs record each
 * argv element and stdin byte for byte, proving the real spawn layer sends
 * values as arguments: shell metacharacters in the text never run, and a
 * title that looks like a flag arrives as one `--title=` element.
 * POSIX only (shebang stubs); test/gstack-post.test.ts covers the logic on
 * Windows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const POST = path.join(ROOT, "bin", "gstack-post");
let tmp = "";
let repo = "";
let stubs = "";
let state = "";
let gitEnv: Record<string, string> = {};

function stub(name: string) {
  const file = path.join(stubs, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash
log="$STUB_LOG/${name}.$(date +%s%N)"
for a in "$@"; do printf '%s\\0' "$a"; done > "$log.args"
cat > "$log.stdin"
for key in GH_REPO GH_HOST GITLAB_REPO GLAB_REPO GITLAB_HOST GITLAB_URI GL_HOST GITLAB_API_HOST GLAB_API_PROTOCOL GLAB_ENABLE_CI_AUTOLOGIN API_PROTOCOL GITLAB_HEAD_REPO GITLAB_SUBFOLDER GITLAB_CI CI_SERVER_FQDN; do
  value=$(printenv "$key" 2>/dev/null) && printf '%s=%s\\n' "$key" "$value" || printf '%s=<unset>\\n' "$key"
done > "$log.env"
case "$1 $2" in
  "config get") if [ "$3" = "subfolder" ] && [ -n "\${STUB_GLAB_SUBFOLDER:-}" ]; then printf '%s\\n' "$STUB_GLAB_SUBFOLDER"; fi ;;
  "repo view") if [ "${name}" = "gh" ] && [ "\${GH_HOST:-}" != "github.com" ]; then exit 1; fi; echo "\${STUB_VISIBILITY:-PRIVATE}" ;;
  "pr view") cat "$STUB_LOG/title" 2>/dev/null ;;
  "pr edit") for a in "$@"; do case "$a" in --title=*) printf '%s\\n' "\${a#--title=}" > "$STUB_LOG/title" ;; esac; done ;;
  "pr create") echo "https://github.com/acme/widget/pull/77" ;;
esac
exit 0
`, { mode: 0o755 });
}

function calls(log: string, name: string) {
  return fs.readdirSync(log).filter(f => f.startsWith(name + ".") && f.endsWith(".args")).sort().map(f => ({
    args: fs.readFileSync(path.join(log, f), "utf8").split("\0").slice(0, -1),
    stdin: fs.readFileSync(path.join(log, f.replace(/\.args$/, ".stdin")), "utf8"),
  })).filter(c => c.args[0] !== "config" && c.args[1] !== "view");
}

function allCalls(log: string, name: string) {
  return fs.readdirSync(log).filter(f => f.startsWith(name + ".") && f.endsWith(".args")).sort().map(f => ({
    args: fs.readFileSync(path.join(log, f), "utf8").split("\0").slice(0, -1),
    stdin: fs.readFileSync(path.join(log, f.replace(/\.args$/, ".stdin")), "utf8"),
    env: Object.fromEntries(fs.readFileSync(path.join(log, f.replace(/\.args$/, ".env")), "utf8").trimEnd().split("\n").map(line => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    })),
  }));
}

function post(args: string[], extraEnv: Record<string, string> = {}, cwd = repo) {
  const log = fs.mkdtempSync(path.join(tmp, "log-"));
  const r = spawnSync(process.execPath, [POST, ...args], {
    cwd, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, ...gitEnv, PATH: `${stubs}${path.delimiter}${process.env.PATH}`, STUB_LOG: log, GSTACK_STATE_ROOT: state, GSTACK_HOME: state, ...extraEnv },
  });
  return { ...r, log };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-post-cli-"));
  repo = path.join(tmp, "repo");
  stubs = path.join(tmp, "bin");
  state = path.join(tmp, "state");
  fs.mkdirSync(repo);
  fs.mkdirSync(stubs);
  fs.mkdirSync(state);
  // The fixture ignores the machine's git config: a global url.insteadOf
  // rewrite would change what `git remote get-url origin` reports.
  fs.writeFileSync(path.join(tmp, "gitconfig"), "");
  gitEnv = { GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args: string[]) => spawnSync("git", args, { cwd: repo, timeout: 10_000, env: { ...process.env, ...gitEnv } });
  git(["init", "-q"]);
  git(["remote", "add", "origin", "git@github.com:acme/widget.git"]);
  git(["config", "user.email", "me@acme-corp.io"]);
  stub("gh");
  stub("glab");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name: string, text: string) {
  const file = path.join(repo, name);
  fs.writeFileSync(file, text);
  return file;
}

function repository(name: string, origin: string) {
  const directory = path.join(tmp, name);
  fs.mkdirSync(directory);
  const git = (args: string[]) => spawnSync("git", args, { cwd: directory, timeout: 10_000, env: { ...process.env, ...gitEnv } });
  git(["init", "-q"]);
  git(["remote", "add", "origin", origin]);
  return directory;
}

function writeTo(directory: string, name: string, text: string) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, text);
  return file;
}

describe("gstack-post executable", () => {
  test("body bytes arrive on stdin unchanged and nothing in them runs", () => {
    const body = "Fixed in `touch pwned-backtick`. $(touch pwned-subst) \"q\" 'single' \\ end\n";
    const r = post(["pr-comment", "12", "--body-file", write("body.md", body)], { GH_REPO: "evil/elsewhere", GH_HOST: "evil.example" });
    expect(r.status).toBe(0);
    expect(calls(r.log, "gh")).toEqual([{ args: ["pr", "comment", "12", "--body-file=-", "--repo", "github.com/acme/widget"], stdin: body }]);
    for (const call of allCalls(r.log, "gh")) {
      expect(call.env.GH_HOST).toBe("github.com");
      expect(call.env.GH_REPO).toBe("<unset>");
      expect(call.args).toContain("github.com/acme/widget");
    }
    expect(fs.existsSync(path.join(repo, "pwned-backtick"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "pwned-subst"))).toBe(false);
  });

  test("a title of --repo evil/x is one --title= argument and reads back", () => {
    const r = post(["pr-title", "7", "--title-file", write("title.txt", "--repo evil/x\n")]);
    expect(r.status).toBe(0);
    expect(calls(r.log, "gh")).toEqual([{ args: ["pr", "edit", "7", "--title=--repo evil/x", "--repo", "github.com/acme/widget"], stdin: "" }]);
  });

  test("pr-create prints the new URL", () => {
    const r = post(["pr-create", "--base", "main", "--draft", "--title-file", write("t2.txt", "v1.0.0 feat: x"), "--body-file", write("b2.md", "body")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("https://github.com/acme/widget/pull/77");
    expect(calls(r.log, "gh")[0]!.args).toEqual(["pr", "create", "--base=main", "--title=v1.0.0 feat: x", "--body-file=-", "--draft", "--repo", "github.com/acme/widget"]);
  });

  test("HIGH is refused and MEDIUM waits for its token, on a public repo", () => {
    const high = post(["pr-comment", "1", "--body-file", write("h.md", "key AKIA" + "1234567890ABCDEF\n")], { STUB_VISIBILITY: "PUBLIC" });
    expect(high.status).toBe(1);
    expect(calls(high.log, "gh")).toEqual([]);
    const file = write("m.md", "cc jane.roe@acme-corp.io\n");
    const medium = post(["pr-comment", "1", "--body-file", file], { STUB_VISIBILITY: "PUBLIC" });
    expect(medium.status).toBe(2);
    expect(medium.stdout).toContain("REPO_VISIBILITY: public");
    expect(medium.stdout).toContain("RULE: pii.email LINE: 1 PART: body");
    expect(calls(medium.log, "gh")).toEqual([]);
    const t = /^TOKEN: (\S+)$/m.exec(medium.stdout)![1]!;
    fs.writeFileSync(file, "cc john.doe@acme-corp.io\n");
    const changed = post(["pr-comment", "1", "--body-file", file, "--confirm", t], { STUB_VISIBILITY: "PUBLIC" });
    expect(changed.status).toBe(2);
    expect(calls(changed.log, "gh")).toEqual([]);
    const t2 = /^TOKEN: (\S+)$/m.exec(changed.stdout)![1]!;
    const sent = post(["pr-comment", "1", "--body-file", file, "--confirm", t2], { STUB_VISIBILITY: "PUBLIC" });
    expect(sent.status).toBe(0);
    expect(calls(sent.log, "gh")).toEqual([{ args: ["pr", "comment", "1", "--body-file=-", "--repo", "github.com/acme/widget"], stdin: "cc john.doe@acme-corp.io\n" }]);
  });

  test("GitLab sends the body as one --description= argument", () => {
    const body = "multi\nline $(id)\n";
    const gitlabRepo = repository("gitlab-repo", "https://gitlab.com/acme/widget.git");
    const r = post(["pr-body", "4", "--body-file", writeTo(gitlabRepo, "g.md", body)], {
      GITLAB_HOST: "evil.example", GITLAB_URI: "evil.example", GL_HOST: "evil.example",
      GITLAB_API_HOST: "evil.example", GLAB_API_PROTOCOL: "http", API_PROTOCOL: "http",
      GITLAB_REPO: "evil/group/repo", GLAB_REPO: "evil/group/repo", GITLAB_HEAD_REPO: "evil/group/repo",
      GITLAB_SUBFOLDER: "evil", GITLAB_CI: "true", CI_SERVER_FQDN: "evil.example", GLAB_ENABLE_CI_AUTOLOGIN: "true", STUB_VISIBILITY: "",
    }, gitlabRepo);
    expect(r.status).toBe(0);
    expect(calls(r.log, "glab")).toEqual([{ args: ["mr", "update", "4", `--description=${body}`, "--repo", "https://gitlab.com/acme/widget"], stdin: "" }]);
    expect(allCalls(r.log, "glab").length).toBeGreaterThan(0);
    const glabCalls = allCalls(r.log, "glab");
    expect(glabCalls[0]!.args).toEqual(["config", "get", "subfolder", "--host=gitlab.com"]);
    for (const call of glabCalls.filter(c => c.args[0] !== "config")) {
      expect(call.env.GITLAB_HOST).toBe("gitlab.com");
      expect(call.env.GITLAB_API_HOST).toBe("gitlab.com");
      expect(call.env.GLAB_API_PROTOCOL).toBe("https");
      expect(call.env.GLAB_ENABLE_CI_AUTOLOGIN).toBe("false");
      expect(call.env.GITLAB_CI).toBe("true");
      expect(call.env.CI_SERVER_FQDN).toBe("evil.example");
      for (const key of ["GITLAB_REPO", "GLAB_REPO", "GITLAB_URI", "GL_HOST", "API_PROTOCOL", "GITLAB_HEAD_REPO", "GITLAB_SUBFOLDER"]) {
        expect(call.env[key]).toBe("<unset>");
      }
      expect(call.args).toContain("https://gitlab.com/acme/widget");
    }
  });

  test("a per-host GitLab subfolder config blocks posting before any write", () => {
    const gitlabRepo = repository("gitlab-subfolder-repo", "https://gitlab.example.internal/acme/widget.git");
    const r = post(["pr-comment", "4", "--body-file", writeTo(gitlabRepo, "body.md", "hello")], {
      STUB_GLAB_SUBFOLDER: "apps/gitlab", GITLAB_SUBFOLDER: "ambient-hostile",
    }, gitlabRepo);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("configured API subfolder");
    expect(calls(r.log, "glab")).toEqual([]);
    const config = allCalls(r.log, "glab");
    expect(config).toHaveLength(1);
    expect(config[0]!.args).toEqual(["config", "get", "subfolder", "--host=gitlab.example.internal"]);
    expect(config[0]!.env.GITLAB_HOST).toBe("gitlab.example.internal");
    expect(config[0]!.env.GITLAB_API_HOST).toBe("gitlab.example.internal");
    expect(config[0]!.env.GLAB_ENABLE_CI_AUTOLOGIN).toBe("false");
    expect(config[0]!.env.GITLAB_SUBFOLDER).toBe("<unset>");
  });
});
