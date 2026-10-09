/**
 * gstack-post: the one write path for PR and issue text (B4).
 *
 * Every value reaches `gh`/`glab` as its own argv element in `--flag=<value>`
 * form, or on stdin, never through a shell string. The text comes from files
 * the agent wrote with its file tool; the helper reads each file once, scans
 * those exact bytes with the shared redaction engine, and sends the same bytes.
 *
 * Exit codes: 0 posted; 1 HIGH finding (or oversize input) refused;
 * 2 MEDIUM findings need confirmation, printed as `RULE:` lines plus a
 * `TOKEN:` that binds the bytes, destination, operation and findings;
 * 3 `gh`/`glab` failed; 64 usage or invalid input. Nothing is posted on any
 * non-zero exit. bin/gstack-post is the CLI; tests drive `runPost` with a fake
 * runner so the logic is covered on every platform.
 */
import { createHash } from "crypto";
import { scan, type Finding, type RepoVisibility } from "./redact-engine";

export const OPS = ["pr-comment", "issue-comment", "reply", "pr-title", "pr-body", "pr-create", "issue-create"] as const;
export type Op = (typeof OPS)[number];
export type HostKind = "github" | "gitlab";

export interface RunResult { status: number; stdout: string; stderr: string }
export type RouteEnv = Readonly<Record<string, string | undefined>>;
export interface PostEnv {
  /** Runs `cmd` with argv (no shell), stdin bytes and an optional child-only env patch. */
  run(cmd: string, args: string[], input?: string, routeEnv?: RouteEnv): RunResult;
  readFile(path: string): string;
  out(text: string): void;
  err(text: string): void;
}

export const EXIT = { posted: 0, refused: 1, confirm: 2, cliFailed: 3, usage: 64 } as const;

export const USAGE = `usage: gstack-post <op> [<target>] [options]

  gstack-post pr-comment    <pr>    --body-file F
  gstack-post issue-comment <issue> --body-file F
  gstack-post reply         <pr>    --to <review-comment-id> --body-file F   (GitHub only)
  gstack-post pr-title      <pr>    --title-file F
  gstack-post pr-body       <pr>    --body-file F
  gstack-post pr-create --base <branch> [--head <branch>] [--draft] --title-file F --body-file F
  gstack-post issue-create  --title-file F --body-file F

  <pr>/<issue> is a number or a URL of this repository on the same host.
  Options: --host github|gitlab (default: detected from the origin remote)
           --repo-visibility public|private|unknown (default: config, then gh/glab)
           --confirm <token>   post bytes whose MEDIUM findings the user confirmed

  Write the text files with your file-write tool; never put the text in a
  shell command. The helper scans the exact bytes it sends.

  Exit: 0 posted · 1 HIGH finding refused · 2 MEDIUM findings need
  confirmation (RULE:/TOKEN: lines on stdout) · 3 gh/glab failed · 64 usage
`;

interface Request {
  op: Op;
  target?: string;
  to?: string;
  base?: string;
  head?: string;
  draft: boolean;
  titleFile?: string;
  bodyFile?: string;
  host?: HostKind;
  visibility?: RepoVisibility;
  confirm?: string;
}

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--to", "--base", "--head", "--title-file", "--body-file", "--host", "--repo-visibility", "--confirm"]);

function parseArgs(argv: string[]): Request {
  const [op, ...rest] = argv;
  if (!OPS.includes(op as Op)) throw new UsageError(op ? `unknown operation "${op}"` : "missing operation");
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let draft = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--draft") { draft = true; continue; }
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.has(name)) {
      const value = name === a ? rest[++i] : a.slice(eq + 1);
      if (value === undefined || value === "") throw new UsageError(`${name} needs a value`);
      if (flags.has(name)) throw new UsageError(`${name} given twice`);
      flags.set(name, value);
      continue;
    }
    if (a.startsWith("-")) throw new UsageError(`unknown option "${a}"`);
    positional.push(a);
  }
  const host = flags.get("--host");
  if (host !== undefined && host !== "github" && host !== "gitlab") throw new UsageError("--host must be github or gitlab");
  const vis = flags.get("--repo-visibility");
  if (vis !== undefined && !["public", "private", "unknown"].includes(vis)) throw new UsageError("--repo-visibility must be public, private or unknown");
  const req: Request = {
    op: op as Op, draft,
    target: positional[0], to: flags.get("--to"), base: flags.get("--base"), head: flags.get("--head"),
    titleFile: flags.get("--title-file"), bodyFile: flags.get("--body-file"),
    host: host as HostKind | undefined, visibility: vis as RepoVisibility | undefined, confirm: flags.get("--confirm"),
  };
  const creates = req.op === "pr-create" || req.op === "issue-create";
  if (positional.length > (creates ? 0 : 1)) throw new UsageError(`unexpected argument "${positional[creates ? 0 : 1]}"`);
  if (!creates && !req.target) throw new UsageError(`${req.op} needs a target (a number or a URL)`);
  const needsTitle = req.op === "pr-title" || creates;
  const needsBody = req.op !== "pr-title";
  if (needsTitle !== !!req.titleFile) throw new UsageError(needsTitle ? `${req.op} needs --title-file` : `${req.op} takes no --title-file`);
  if (needsBody !== !!req.bodyFile) throw new UsageError(needsBody ? `${req.op} needs --body-file` : `${req.op} takes no --body-file (use --title-file)`);
  if ((req.op === "reply") !== !!req.to) throw new UsageError(req.op === "reply" ? "reply needs --to <review-comment-id>" : "--to applies to reply only");
  if (req.to !== undefined && !/^[1-9][0-9]*$/.test(req.to)) throw new UsageError("--to must be a numeric comment id");
  if ((req.op === "pr-create") !== !!req.base) throw new UsageError(req.op === "pr-create" ? "pr-create needs --base <branch>" : "--base applies to pr-create only");
  if (req.op !== "pr-create" && (req.head || req.draft)) throw new UsageError("--head and --draft apply to pr-create only");
  return req;
}

interface Remote { host: string; segments: string[]; kind: HostKind }

function hostedId(value: string) {
  const raw = value.trim();
  if (!raw || /[\u0000-\u001f\u007f?#]/.test(raw)) return undefined;
  let host = "";
  let pathname = "";
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    let url: URL;
    try { url = new URL(raw); } catch { return undefined; }
    const protocol = url.protocol.toLowerCase();
    if (protocol !== "https:" && protocol !== "ssh:") return undefined;
    if (url.search || url.hash || (url.port && !(protocol === "ssh:" && url.port === "22"))) return undefined;
    host = url.hostname.toLowerCase();
    pathname = url.pathname.replace(/^\//, "");
  } else {
    const scp = raw.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
    if (!scp) return undefined;
    host = scp[1]!.toLowerCase();
    pathname = scp[2]!;
  }
  if (!host || host.includes(":")) return undefined;
  pathname = pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!pathname || pathname.includes("//")) return undefined;
  const segments: string[] = [];
  for (const encoded of pathname.split("/")) {
    let segment: string;
    try { segment = decodeURIComponent(encoded); } catch { return undefined; }
    if (!segment || segment === "." || segment === ".." || /[\\/\u0000-\u001f\u007f]/.test(segment)) return undefined;
    segments.push(segment);
  }
  return segments.length >= 2 ? { host, segments } : undefined;
}

function repoRef(remote: Remote): string {
  return `${remote.host}/${remote.segments.join("/")}`;
}

function repoUrl(remote: Remote): string {
  return `https://${remote.host}/${remote.segments.map(encodeURIComponent).join("/")}`;
}

function sameRemote(a: { host: string; segments: string[] }, b: { host: string; segments: string[] }): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase()
    && a.segments.length === b.segments.length
    && a.segments.every((segment, index) => segment.toLowerCase() === b.segments[index]!.toLowerCase());
}

/** Remove ambient provider routing and pin documented host settings to origin. */
function routingEnv(remote: Remote): RouteEnv {
  if (remote.kind === "github") return {
    GH_HOST: remote.host,
    GH_REPO: undefined,
  };
  return {
    GITLAB_HOST: remote.host,
    GITLAB_URI: undefined,
    GL_HOST: undefined,
    GITLAB_API_HOST: remote.host,
    GLAB_API_PROTOCOL: "https",
    // GitLab CI auto-login can ignore explicit host variables and route via
    // CI_SERVER_FQDN when enabled; the helper must retain its origin binding.
    GLAB_ENABLE_CI_AUTOLOGIN: "false",
    API_PROTOCOL: undefined,
    GITLAB_REPO: undefined,
    GLAB_REPO: undefined,
    GITLAB_HEAD_REPO: undefined,
    GITLAB_SUBFOLDER: undefined,
  };
}

function runHosted(env: PostEnv, remote: Remote, cmd: "gh" | "glab", args: string[], input?: string): RunResult {
  return env.run(cmd, args, input, routingEnv(remote));
}

/**
 * `GITLAB_SUBFOLDER` is unset in hosted calls so per-host glab config can
 * otherwise add an installation prefix to API requests. Read that effective
 * setting through glab's host-scoped config lookup and refuse prefixes until
 * the route can be bound explicitly.
 */
function verifyGitLabRoute(env: PostEnv, remote: Remote): void {
  const config = runHosted(env, remote, "glab", ["config", "get", "subfolder", `--host=${remote.host}`]);
  if (config.status !== 0) throw new UsageError(`cannot verify GitLab's configured API subfolder for ${remote.host}; refusing to post`);
  const subfolder = config.stdout.trim().replace(/^\/+|\/+$/g, "");
  if (subfolder) throw new UsageError(`GitLab host ${remote.host} has a configured API subfolder; gstack-post cannot bind that route safely and will not post`);
}

/**
 * The origin remote's host and path. Custom hosts require an explicit provider
 * or a provider query that is itself routed to this exact origin.
 */
function resolveRemote(env: PostEnv, forced?: HostKind): Remote {
  const r = env.run("git", ["remote", "get-url", "origin"]);
  const origin = r.status === 0 ? hostedId(r.stdout) : undefined;
  if (!origin) throw new UsageError("cannot read a hosted origin remote (git remote get-url origin)");
  const named: HostKind | undefined = origin.host === "github.com" || origin.host.endsWith(".ghe.com")
    ? "github"
    : origin.host === "gitlab.com" ? "gitlab" : undefined;
  if (named && forced && forced !== named) throw new UsageError(`--host ${forced} conflicts with origin host ${origin.host}`);
  if (named) {
    const remote = { ...origin, kind: named };
    if (named === "gitlab") verifyGitLabRoute(env, remote);
    return remote;
  }
  if (forced) {
    const remote = { ...origin, kind: forced };
    if (forced === "gitlab") verifyGitLabRoute(env, remote);
    return remote;
  }
  for (const kind of forced ? [forced] : (["github", "gitlab"] as const)) {
    const probeRemote = { ...origin, kind };
    if (kind === "gitlab") verifyGitLabRoute(env, probeRemote);
    const q = kind === "github"
      ? runHosted(env, probeRemote, "gh", ["repo", "view", repoRef(probeRemote), "--json", "url", "--jq", ".url"])
      : runHosted(env, probeRemote, "glab", ["repo", "view", repoUrl(probeRemote), "--output", "json"]);
    if (q.status !== 0) continue;
    let url = q.status === 0 ? q.stdout : "";
    if (kind === "gitlab" && url) { try { url = String(JSON.parse(url).web_url ?? ""); } catch { url = ""; } }
    const id = url ? hostedId(url) : undefined;
    if (!id || !sameRemote(origin, id)) throw new UsageError(`${kind} resolved a repository other than origin ${repoRef({ ...origin, kind })}`);
    return { ...origin, kind };
  }
  throw new UsageError(`cannot tell whether ${origin.host} is GitHub or GitLab; pass --host github|gitlab`);
}

/** A number, or a URL of this repository on the remote's host, as a number. */
function targetNumber(target: string, op: Op, remote: Remote): string {
  if (/^[1-9][0-9]*$/.test(target)) return target;
  let url: URL;
  try { url = new URL(target); } catch { throw new UsageError(`target "${target}" is neither a number nor a URL`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError("target URL must be http(s)");
  if (url.hostname.toLowerCase() !== remote.host) throw new UsageError(`target URL host ${url.hostname} is not this repository's host ${remote.host}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const issue = op === "issue-comment";
  const markers = remote.kind === "github" ? [issue ? "issues" : "pull"] : ["-", issue ? "issues" : "merge_requests"];
  const at = parts.findIndex((p, i) => markers.every((m, j) => parts[i + j] === m));
  const repo = at < 0 ? [] : parts.slice(0, at);
  const num = at < 0 ? undefined : parts[at + markers.length];
  const same = repo.length === remote.segments.length && repo.every((s, i) => s.toLowerCase() === remote.segments[i]!.toLowerCase());
  if (!same || !num || !/^[1-9][0-9]*$/.test(num)) throw new UsageError(`target URL is not ${issue ? "an issue" : "a pull/merge request"} of ${remote.segments.join("/")}`);
  return num;
}

function readText(env: PostEnv, file: string, what: "title" | "body"): string {
  let text: string;
  try { text = env.readFile(file); } catch { throw new UsageError(`cannot read ${what} file ${file}; write it with your file-write tool first`); }
  if (what === "title") {
    text = text.replace(/\r?\n$/, "");
    if (/[\r\n]/.test(text)) throw new UsageError("title file must hold one line");
  }
  if (!text.trim()) throw new UsageError(`${what} file ${file} is empty; write the text first`);
  return text;
}

function visibility(env: PostEnv, req: Request, remote: Remote, configBin: string): RepoVisibility {
  if (req.visibility) return req.visibility;
  const norm = (s: string) => {
    const v = s.trim().toLowerCase();
    return v === "public" || v === "private" || v === "unknown" ? v : undefined;
  };
  const cfg = env.run(configBin, ["get", "redact_repo_visibility"]);
  const fromConfig = cfg.status === 0 ? norm(cfg.stdout) : undefined;
  if (fromConfig) return fromConfig;
  if (remote.kind === "github") {
    const gh = runHosted(env, remote, "gh", ["repo", "view", repoRef(remote), "--json", "visibility", "--jq", ".visibility"]);
    return (gh.status === 0 && norm(gh.stdout)) || "unknown";
  }
  const gl = runHosted(env, remote, "glab", ["repo", "view", repoUrl(remote), "--output", "json"]);
  if (gl.status !== 0) return "unknown";
  try { return norm(String(JSON.parse(gl.stdout).visibility ?? "")) ?? "unknown"; } catch { return "unknown"; }
}

type Part = "title" | "body";
interface Located { part: Part; finding: Finding }

function scanParts(parts: Array<[Part, string]>, vis: RepoVisibility, selfEmail: string | undefined) {
  const found: Located[] = [];
  let oversize = false;
  for (const [part, text] of parts) {
    const result = scan(text, { repoVisibility: vis, ...(selfEmail ? { selfEmail } : {}) });
    oversize ||= result.oversize;
    for (const finding of result.findings) found.push({ part, finding });
  }
  return { found, oversize };
}

export function confirmationToken(fields: Record<string, unknown>, parts: Array<[Part, string]>, medium: Located[]): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(fields));
  for (const [part, text] of parts) h.update(`\0${part}\0${Buffer.byteLength(text)}\0`).update(text);
  h.update(JSON.stringify(medium.map(m => [m.part, m.finding.id, m.finding.line, m.finding.col])));
  return h.digest("hex").slice(0, 24);
}

/** The argv that sends one operation; `stdin` carries the body where the CLI reads it from "-". */
function command(remote: Remote, op: Op, n: string | undefined, req: Request, title?: string, body?: string): { cmd: "gh" | "glab"; args: string[]; stdin?: string } {
  if (remote.kind === "github") {
    const repo = repoRef(remote);
    const apiRepo = remote.segments.map(encodeURIComponent).join("/");
    switch (op) {
      case "pr-comment": return { cmd: "gh", args: ["pr", "comment", n!, "--body-file=-", "--repo", repo], stdin: body };
      case "issue-comment": return { cmd: "gh", args: ["issue", "comment", n!, "--body-file=-", "--repo", repo], stdin: body };
      case "reply": return { cmd: "gh", args: ["api", `--hostname=${remote.host}`, "--method=POST", `repos/${apiRepo}/pulls/${n}/comments/${req.to}/replies`, "--field=body=@-"], stdin: body };
      case "pr-title": return { cmd: "gh", args: ["pr", "edit", n!, `--title=${title}`, "--repo", repo] };
      case "pr-body": return { cmd: "gh", args: ["pr", "edit", n!, "--body-file=-", "--repo", repo], stdin: body };
      case "pr-create": return { cmd: "gh", args: ["pr", "create", `--base=${req.base}`, ...(req.head ? [`--head=${req.head}`] : []), `--title=${title}`, "--body-file=-", ...(req.draft ? ["--draft"] : []), "--repo", repo], stdin: body };
      case "issue-create": return { cmd: "gh", args: ["issue", "create", `--title=${title}`, "--body-file=-", "--repo", repo], stdin: body };
    }
  }
  const repo = repoUrl(remote);
  const inRepo = (args: string[]) => [...args, "--repo", repo];
  switch (op) {
    case "pr-comment": return { cmd: "glab", args: inRepo(["mr", "note", n!, `--message=${body}`]) };
    case "issue-comment": return { cmd: "glab", args: inRepo(["issue", "note", n!, `--message=${body}`]) };
    case "pr-title": return { cmd: "glab", args: inRepo(["mr", "update", n!, `--title=${title}`]) };
    case "pr-body": return { cmd: "glab", args: inRepo(["mr", "update", n!, `--description=${body}`]) };
    case "pr-create": return { cmd: "glab", args: inRepo(["mr", "create", `--target-branch=${req.base}`, ...(req.head ? [`--source-branch=${req.head}`] : []), `--title=${title}`, `--description=${body}`, "--yes", ...(req.draft ? ["--draft"] : [])]) };
    case "issue-create": return { cmd: "glab", args: inRepo(["issue", "create", `--title=${title}`, `--description=${body}`, "--yes"]) };
    default: throw new UsageError(`${op} is not supported on GitLab`);
  }
}

/** `gh pr edit` can fail on the retired projectCards GraphQL field; the REST PATCH sends the same bytes. */
function restEdit(remote: Remote, op: Op, n: string, title?: string, body?: string): { cmd: "gh"; args: string[]; stdin?: string } {
  const apiRepo = remote.segments.map(encodeURIComponent).join("/");
  return op === "pr-title"
    ? { cmd: "gh", args: ["api", `--hostname=${remote.host}`, "--method=PATCH", `repos/${apiRepo}/pulls/${n}`, `--raw-field=title=${title}`] }
    : { cmd: "gh", args: ["api", `--hostname=${remote.host}`, "--method=PATCH", `repos/${apiRepo}/pulls/${n}`, "--field=body=@-", "--silent"], stdin: body };
}

function readBackTitle(env: PostEnv, remote: Remote, n: string): string | undefined {
  const r = remote.kind === "github"
    ? runHosted(env, remote, "gh", ["pr", "view", n, "--json", "title", "--jq", ".title", "--repo", repoRef(remote)])
    : runHosted(env, remote, "glab", ["mr", "view", n, "--output", "json", "--repo", repoUrl(remote)]);
  if (r.status !== 0) return undefined;
  if (remote.kind === "github") return r.stdout.replace(/\r?\n$/, "");
  try { return String(JSON.parse(r.stdout).title); } catch { return undefined; }
}

function send(env: PostEnv, remote: Remote, req: Request, n: string | undefined, title?: string, body?: string): number {
  let c = command(remote, req.op, n, req, title, body);
  let r = runHosted(env, remote, c.cmd, c.args, c.stdin);
  if (r.status !== 0 && remote.kind === "github" && (req.op === "pr-title" || req.op === "pr-body") && /projectCards/.test(r.stderr)) {
    c = restEdit(remote, req.op, n!, title, body);
    r = runHosted(env, remote, c.cmd, c.args, c.stdin);
  }
  if (r.status !== 0) {
    env.err(`gstack-post: ${c.cmd} failed (exit ${r.status}); nothing more was sent.\n${r.stderr}`);
    return EXIT.cliFailed;
  }
  if (req.op === "pr-title") {
    for (let attempt = 0; readBackTitle(env, remote, n!) !== title; attempt++) {
      if (attempt === 1) {
        env.err("gstack-post: the PR title still differs from the title file after one retry.\n");
        return EXIT.cliFailed;
      }
      if (runHosted(env, remote, c.cmd, c.args, c.stdin).status !== 0) {
        env.err("gstack-post: retrying the title edit failed.\n");
        return EXIT.cliFailed;
      }
    }
  }
  if (r.stdout.trim()) env.out(r.stdout.endsWith("\n") ? r.stdout : r.stdout + "\n");
  env.out(`POSTED: ${req.op}${n ? ` ${n}` : ""}\n`);
  return EXIT.posted;
}

export function runPost(argv: string[], env: PostEnv, configBin = "gstack-config"): number {
  if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0]!)) {
    (argv.length === 0 ? env.err : env.out)(USAGE);
    return argv.length === 0 ? EXIT.usage : EXIT.posted;
  }
  try {
    const req = parseArgs(argv);
    const remote = resolveRemote(env, req.host);
    if (req.op === "reply" && remote.kind !== "github") throw new UsageError("reply is supported on GitHub only");
    const n = req.target === undefined ? undefined : targetNumber(req.target, req.op, remote);
    const title = req.titleFile ? readText(env, req.titleFile, "title") : undefined;
    const body = req.bodyFile ? readText(env, req.bodyFile, "body") : undefined;
    const parts: Array<[Part, string]> = [];
    if (title !== undefined) parts.push(["title", title]);
    if (body !== undefined) parts.push(["body", body]);

    const vis = visibility(env, req, remote, configBin);
    const email = env.run("git", ["config", "user.email"]);
    const { found, oversize } = scanParts(parts, vis, email.status === 0 ? email.stdout.trim() || undefined : undefined);
    env.out(`REPO_VISIBILITY: ${vis}\n`);
    const line = (m: Located) => `RULE: ${m.finding.id} LINE: ${m.finding.line} PART: ${m.part}\n`;
    const high = found.filter(m => m.finding.severity === "HIGH");
    if (oversize || high.length) {
      for (const m of high) env.out(`HIGH ${line(m)}`);
      env.err(oversize
        ? "gstack-post: refused, the text is too large to scan safely. Nothing was posted.\n"
        : `gstack-post: refused, HIGH finding (${[...new Set(high.map(m => m.finding.id))].join(", ")}). Remove the value at its source and rotate it if it is a credential; no confirmation can post it.\n`);
      return EXIT.refused;
    }
    for (const m of found.filter(f => f.finding.severity === "LOW" || f.finding.severity === "WARN")) env.err(`note: ${m.finding.severity} ${line(m)}`);
    const medium = found.filter(m => m.finding.severity === "MEDIUM");
    if (medium.length) {
      const token = confirmationToken(
        { op: req.op, host: remote.kind, repo: [remote.host, ...remote.segments].join("/"), target: n ?? null, to: req.to ?? null, base: req.base ?? null, head: req.head ?? null, draft: req.draft },
        parts, medium);
      if (req.confirm !== token) {
        for (const m of medium) env.out(line(m));
        env.out(`TOKEN: ${token}\n`);
        env.err(req.confirm
          ? "gstack-post: the text, destination or findings changed since that token; nothing was posted. Ask about these findings again.\n"
          : "gstack-post: MEDIUM findings; nothing was posted. Ask the user about each finding; to post these exact bytes, rerun with --confirm <token>. Any edit needs a new scan.\n");
        return EXIT.confirm;
      }
    }
    return send(env, remote, req, n, title, body);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    env.err(`gstack-post: ${e.message} (gstack-post --help shows usage)\n`);
    return EXIT.usage;
  }
}
