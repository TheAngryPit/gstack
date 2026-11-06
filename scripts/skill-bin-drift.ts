#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * Static skill-to-bin drift scanner (GSTA-133). Skills teach gstack's own bins;
 * when a template names a bin that is gone, or passes a flag the bin's parser
 * does not accept, the model runs a wrong command that still passes CI.
 *
 * Inputs: SKILL.md.tmpl (root and one level down), <skill>/sections/*.md.tmpl,
 * <skill>/references/*.md, and the Claude-host renders (SKILL.md, sections/*.md, which carry the
 * AUTO-GENERATED banner) so resolver-generated commands count. A render finding
 * that its own skill's templates already report is dropped. --skill NAME limits
 * the scan to one skill folder (the /write-skill diet step). Only fenced code
 * blocks and inline backtick spans are read, so prose placeholders never match.
 *
 * Bin spellings recognised (every form the templates and renders use today):
 *   bin/gstack-x                                  (repo-relative)
 *   ~/.claude/skills/gstack/bin/gstack-x          (Claude install; also .claude/skills/...)
 *   $HOME/.claude/skills/gstack/bin/gstack-x, "$HOME"/.claude/skills/gstack/bin/gstack-x
 *   $GSTACK_BIN/gstack-x, ${GSTACK_BIN}/gstack-x  (env-var hosts)
 *   {{BIN_DIR}}/gstack-x, {{INSTALLED_BIN_DIR}}/gstack-x (template placeholders)
 *   $GSTACK_ROOT/bin/gstack-x, $RUNTIME_ROOT/bin/gstack-x, {{RUNTIME_ROOT}}/bin/gstack-x
 *   ${B%/browse/*}/bin/gstack-x                   (any ${...}/bin/ expansion)
 *
 * A call's arguments end at an unquoted pipe, ;, &, &&, ||, redirect, $( ),
 * backtick, closing parenthesis, comment or line end (backslash continuations
 * join). <VALUE> and <two words> placeholders are words, not redirects. Flags after -- are
 * positional.
 *
 * Flag discovery never executes a bin. Bash: case arm labels (--a), --a|--b),
 * --a=*)) whose body does not only refuse, and test comparisons
 * ([ "$1" = "--a" ]). TS/JS/Python: --flag tokens in code and string
 * literals (usage text included), in the bin and in its relative imports one
 * level deep. A bash bin that hands off to a .ts/.js/.mjs/.py file, or passes
 * "$@" to a .sh file or sibling gstack-* bin, gains that file's flags. A bin
 * .gitignore lists as a build output is read from bin/<name>.ts; with no
 * source its flags are unchecked (UNCHECKED list).
 *
 * Reported, never failed: PERMISSIVE (a bash arg loop whose catch-all *) arm
 * neither errors nor has a -*) error arm beside it, or a bash bin that never
 * reads its arguments) and NO_HELP (no --help handling and no usage text
 * outside comments). A sourced .sh library that never reads arguments gets
 * neither label. Failures: DRIFT_UNKNOWN_BIN, DRIFT_UNKNOWN_FLAG.
 * test/skill-bin-drift.test.ts holds today's misses in a shrink-only allowlist
 * (test/fixtures/skill-bin-drift-allowlist.json).
 */
import * as fs from 'fs';
import * as path from 'path';

export const FIX_LINE = "fix the template or the bin's parser; the allowlist only shrinks";
export const ALLOWLIST_FILE = 'test/fixtures/skill-bin-drift-allowlist.json';

export type DriftCode = 'DRIFT_UNKNOWN_BIN' | 'DRIFT_UNKNOWN_FLAG';

export interface BinCall {
  file: string;
  line: number;
  bin: string;
  flags: string[];
}

export interface Finding {
  code: DriftCode;
  file: string;
  line: number;
  bin: string;
  flag?: string;
  key: string;
  fix: string;
}

export interface BinProfile {
  bin: string;
  exists: boolean;
  flagsKnown: boolean;
  flags: Set<string>;
  permissive: boolean;
  hasHelp: boolean;
  sources: string[];
}

export interface DriftReport {
  inputs: string[];
  calls: BinCall[];
  findings: Finding[];
  binsInvoked: string[];
  permissive: string[];
  noHelp: string[];
  unchecked: string[];
}

type Lang = 'sh' | 'ts' | 'py';

const BIN_NAME = 'gstack-[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?';
const BIN_PREFIX = String.raw`(?:~|\$HOME|\$\{HOME\}|"\$HOME")?/?\.claude/skills/gstack/|\$\{[^}\s]*\}/|\$\{?[A-Z_][A-Z0-9_]*\}?/|\{\{[A-Z_]+\}\}/`;
const BIN_RE = new RegExp(
  String.raw`(?<![\w./$}-])(?:(?:${BIN_PREFIX})?bin/|\$\{?GSTACK_BIN\}?/|\{\{(?:INSTALLED_)?BIN_DIR\}\}/)(${BIN_NAME})(?![\w.-]*[\w])`,
  'g',
);
const FLAG_WORD = /^--[A-Za-z0-9][A-Za-z0-9_-]*/;

/** Shell-style words after a bin, up to the first command boundary. */
export function binArgs(rest: string, openQuote: string | null = null): string[] {
  const words: string[] = [];
  let i = 0;
  if (openQuote) {
    const close = rest.indexOf(openQuote);
    if (close < 0) return [];
    i = close + 1;
  }
  let cur = '';
  let has = false;
  let quote: string | null = null;
  const push = () => { if (has) words.push(cur); cur = ''; has = false; };
  for (; i < rest.length; i++) {
    const c = rest[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') cur += rest[++i] ?? '';
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\') { cur += rest[++i] ?? ''; has = true; continue; }
    if (/\s/.test(c)) { push(); continue; }
    if (c === '>') {
      if (/^\d+$/.test(cur)) { cur = ''; has = false; }
      push();
      if ('>&|'.includes(rest[i + 1] ?? '')) i++;
      while (/[ \t]/.test(rest[i + 1] ?? '')) i++;
      while (i + 1 < rest.length && !/\s/.test(rest[i + 1]!) && !'|;&`)'.includes(rest[i + 1]!)) i++;
      continue;
    }
    if ('|;&`)'.includes(c) || (c === '$' && rest[i + 1] === '(')) break;
    if (c === '#' && !has) break;
    if (c === '<') {
      const ph = /^<[A-Za-z_][^<>\n]*>/.exec(rest.slice(i));
      if (!ph) break;
      cur += ph[0]; has = true; i += ph[0].length - 1;
      continue;
    }
    cur += c; has = true;
  }
  push();
  return words;
}

/** The quote character open at `end` in a shell line, if any. */
function openQuoteAt(text: string, end: number): string | null {
  let quote: string | null = null;
  for (let i = 0; i < end; i++) {
    const c = text[i]!;
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"') i++; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') quote = c;
  }
  return quote;
}

function flagsOf(words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    if (w === '--') break;
    const m = FLAG_WORD.exec(w);
    if (m) out.push(m[0]);
  }
  return out;
}

function callsInSnippet(snippet: string, file: string, line: number, out: BinCall[]): void {
  for (const m of snippet.matchAll(BIN_RE)) {
    const end = m.index! + m[0].length;
    const words = binArgs(snippet.slice(end), openQuoteAt(snippet, m.index!));
    out.push({ file, line, bin: m[1]!, flags: flagsOf(words) });
  }
}

const FENCE = /^\s*(`{3,}|~{3,})/;

/** Bin calls inside fenced code blocks and inline backtick spans of one markdown file. */
export function scanText(text: string, file: string): BinCall[] {
  const out: BinCall[] = [];
  const lines = text.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const marker = FENCE.exec(raw);
    if (marker) {
      if (!fence) fence = marker[1]!;
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fence) {
      let logical = raw;
      const start = i;
      while (/\\$/.test(logical) && i + 1 < lines.length && !FENCE.test(lines[i + 1]!)) {
        logical = logical.slice(0, -1) + ' ' + lines[++i]!;
      }
      callsInSnippet(logical, file, start + 1, out);
      continue;
    }
    for (const span of raw.matchAll(/(`+)([^`]+?)\1(?!`)/g)) callsInSnippet(span[2]!, file, i + 1, out);
  }
  return out;
}

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function isFile(file: string): boolean {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function langOf(file: string, text: string): Lang {
  if (/\.py$/.test(file)) return 'py';
  if (/\.(?:[cm]?[jt]s|tsx)$/.test(file)) return 'ts';
  const first = text.split('\n', 1)[0] ?? '';
  if (/^#!.*\bpython/.test(first)) return 'py';
  if (/^#!.*\b(?:bun|node|deno)\b/.test(first)) return 'ts';
  return 'sh';
}

const COMMENT: Record<Lang, RegExp> = { sh: /^\s*#/, py: /^\s*#/, ts: /^\s*(?:\/\/|\*|\/\*)/ };

function codeLines(text: string, lang: Lang): string[] {
  return text.split('\n').filter(l => !COMMENT[lang].test(l));
}

/** --flag tokens in TS/JS/Python code and string literals, usage text included. */
export function literalFlags(text: string, lang: Lang = 'ts'): Set<string> {
  const flags = new Set<string>();
  for (const line of codeLines(text, lang)) {
    for (const m of line.matchAll(/(?<![\w-])(--[A-Za-z][A-Za-z0-9_-]*)/g)) flags.add(m[1]!);
  }
  return flags;
}

const ARM = /^[ \t]*\(?[ \t]*((?:["']?-[-\w=*]*["']?[ \t]*\|[ \t]*)*["']?-[-\w=*]*["']?)[ \t]*\)([\s\S]*?)(?:;;|\besac\b)/gm;
const refuses = (body: string) => !/\bshift\b|\b[A-Za-z_][A-Za-z0-9_]*=/.test(body)
  && /\b(?:refuse|die|fail)\b|\bexit\s+[1-9]|\breturn\s+[1-9]/.test(body);

/** Flags a bash bin's case arms (minus arms that only refuse) and test comparisons accept. */
export function bashFlags(text: string): Set<string> {
  const flags = new Set<string>();
  const code = codeLines(text, 'sh').join('\n');
  for (const arm of code.matchAll(ARM)) {
    if (refuses(arm[2]!)) continue;
    for (const label of arm[1]!.split('|')) {
      const m = FLAG_WORD.exec(label.trim().replace(/^["']|["']$/g, ''));
      if (m) flags.add(m[0]);
    }
  }
  for (const m of code.matchAll(/(?:==?|!=)\s*["']?(--[A-Za-z0-9][A-Za-z0-9_-]*)/g)) flags.add(m[1]!);
  return flags;
}

/** Top-level bash code plus the bodies of functions it (transitively) hands "$@" to; other functions' $1 is not the bin's. */
function argScope(code: string): string {
  const top: string[] = [];
  const funcs = new Map<string, string[]>();
  let cur: string | null = null;
  for (const line of code.split('\n')) {
    const start = /^\s*(?:function\s+)?([\w-]+)\s*\(\)\s*\{?\s*$/.exec(line);
    if (cur === null && start) { cur = start[1]!; funcs.set(cur, []); continue; }
    if (cur !== null) {
      if (/^\}/.test(line)) cur = null;
      else funcs.get(cur)!.push(line);
      continue;
    }
    top.push(line);
  }
  const scope = [...top];
  const included = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    const text = scope.join('\n');
    for (const [name, body] of funcs) {
      if (included.has(name) || !new RegExp(`(?:^|[\\s;&|(])${name}\\s+"\\$@"`, 'm').test(text)) continue;
      included.add(name);
      scope.push(...body);
      grew = true;
    }
  }
  return scope.join('\n');
}

const readsArgs = (code: string) => /\$\{?[1-9@*#]|getopts|\bshift\b/.test(code);

/** A sourced .sh function library: it never reads arguments at top level, so permissive and help checks do not apply. */
export function isShellLibrary(bin: string, text: string): boolean {
  return bin.endsWith('.sh') && !readsArgs(argScope(codeLines(text, 'sh').join('\n')));
}

/** In a case over the arguments, a catch-all *) arm with no error and no -*) error arm; or arguments never read. */
export function bashPermissive(text: string): boolean {
  const code = argScope(codeLines(text, 'sh').join('\n'));
  if (!readsArgs(code)) return true;
  const argVars = new Set(['1']);
  for (const m of code.matchAll(/\bfor\s+(\w+)\s+in\s+"\$@"/g)) argVars.add(m[1]!);
  for (const m of code.matchAll(/\b(\w+)="?\$\{?1\b/g)) argVars.add(m[1]!);
  const blocks = [...code.matchAll(/\bcase\s+"?\$\{?(\w+)[^\n]*?\bin\b([\s\S]*?)\besac\b/g)].filter(m => argVars.has(m[1]!));
  const arms = blocks.flatMap(block => [...block[2]!.matchAll(/^[ \t]*\(?[ \t]*(["']?-?-?\*["']?)[ \t]*\)([\s\S]*?)(?:;;|$)/gm)]);
  const errors = (body: string) => /\bexit\b|\breturn\b|\bdie\b|usage|>&2|\berr\b|fail|refuse/i.test(body);
  const dashError = arms.some(a => /-/.test(a[1]!) && errors(a[2]!));
  const silentCatchAll = arms.some(a => !/-/.test(a[1]!) && !errors(a[2]!));
  return silentCatchAll && !dashError;
}

function hasUsage(text: string, lang: Lang): boolean {
  return /usage/i.test(codeLines(text, lang).filter(l => !/^#!/.test(l)).join('\n'));
}

function resolveModule(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts')]) {
    if (isFile(cand)) return cand;
  }
  return null;
}

/** Relative imports (static, dynamic and require) of one source file. */
export function relativeImports(file: string, text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    const hit = resolveModule(file, m[1]!);
    if (hit) out.add(hit);
  }
  return [...out];
}

/** Files a bash bin hands its arguments to: .ts/.js/.mjs/.py paths, and .sh files or sibling bins given "$@". */
export function bashHandoffs(binFile: string, text: string, root: string): string[] {
  const out = new Set<string>();
  const binDir = path.dirname(binFile);
  for (const line of codeLines(text, 'sh')) {
    const forwards = /"\$@"/.test(line);
    for (const m of line.matchAll(/[^\s'"=;|&<>]+\.(?:[cm]?[jt]s|py|sh)(?![\w.])/g)) {
      if (m[0].endsWith('.sh') && !forwards) continue;
      const tail = m[0].replace(/^.*(?:\}|\)|\$[A-Za-z_][A-Za-z0-9_]*)/, '').replace(/^\//, '');
      if (!tail) continue;
      const hit = [binDir, root].map(dir => path.resolve(dir, tail)).find(c => c !== binFile && isFile(c));
      if (hit) out.add(hit);
    }
    if (!forwards) continue;
    for (const m of line.matchAll(new RegExp(`(?:^|[/\\s"])(${BIN_NAME})(?![\\w.-])`, 'g'))) {
      const cand = path.join(binDir, m[1]!);
      if (cand !== binFile && isFile(cand)) out.add(cand);
    }
  }
  return [...out];
}

/** Bin names .gitignore lists as build outputs (bin/<pattern> lines). */
function builtPatterns(root: string): RegExp[] {
  return readText(path.join(root, '.gitignore')).split('\n')
    .map(l => /^\/?bin\/(gstack-[^\s/]+)$/.exec(l.trim())?.[1])
    .filter((p): p is string => Boolean(p))
    .map(p => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
}

/** Static profile of one bin: accepted flags, permissive parsing, help text. */
export function profileBin(root: string, bin: string, built: RegExp[] = builtPatterns(root)): BinProfile {
  const binFile = path.join(root, 'bin', bin);
  const profile: BinProfile = { bin, exists: false, flagsKnown: true, flags: new Set(), permissive: false, hasHelp: false, sources: [] };
  const seen = new Set<string>();
  const absorb = (file: string, text: string, lang: Lang, flags: Set<string>) => {
    seen.add(file);
    profile.sources.push(path.relative(root, file));
    for (const f of flags) profile.flags.add(f);
    if (hasUsage(text, lang)) profile.hasHelp = true;
  };
  const addScript = (file: string, followImports: boolean) => {
    if (seen.has(file)) return;
    const text = readText(file);
    const lang = langOf(file, text);
    absorb(file, text, lang, literalFlags(text, lang));
    if (followImports && lang === 'ts') for (const dep of relativeImports(file, text)) addScript(dep, false);
  };
  if (built.some(re => re.test(bin)) && !/\.(?:[cm]?[jt]s|py)$/.test(bin)) {
    profile.exists = true;
    if (isFile(`${binFile}.ts`)) addScript(`${binFile}.ts`, true);
    else profile.flagsKnown = false;
  } else if (isFile(binFile)) {
    profile.exists = true;
    const text = readText(binFile);
    if (langOf(binFile, text) !== 'sh') {
      addScript(binFile, true);
    } else {
      absorb(binFile, text, 'sh', bashFlags(text));
      if (isShellLibrary(bin, text)) profile.hasHelp = true;
      else profile.permissive = bashPermissive(text);
      for (const handoff of bashHandoffs(binFile, text, root)) {
        if (seen.has(handoff)) continue;
        const handoffText = readText(handoff);
        if (langOf(handoff, handoffText) !== 'sh') addScript(handoff, true);
        else absorb(handoff, handoffText, 'sh', bashFlags(handoffText));
      }
    }
  }
  if (profile.flags.has('--help')) profile.hasHelp = true;
  return profile;
}

function subdirs(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== 'dist')
    .map(d => d.name)
    .sort();
}

/** Template sources, sections/references and Claude-host renders, repo-relative; one skill's when `skill` is set. */
export function listInputs(root: string, skill?: string): string[] {
  const out: string[] = [];
  const add = (rel: string) => { if (isFile(path.join(root, rel))) out.push(rel); };
  if (!skill) { add('SKILL.md.tmpl'); add('SKILL.md'); }
  for (const dir of skill ? [skill] : subdirs(root)) {
    add(`${dir}/SKILL.md.tmpl`);
    add(`${dir}/SKILL.md`);
    for (const sub of ['sections', 'references']) {
      const full = path.join(root, dir, sub);
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) continue;
      for (const name of fs.readdirSync(full).sort()) {
        if (name.endsWith('.md.tmpl') || name.endsWith('.md')) add(`${dir}/${sub}/${name}`);
      }
    }
  }
  return out;
}

const isTemplate = (file: string) => file.endsWith('.tmpl');
const skillDirOf = (file: string) => (file.includes('/') ? file.split('/')[0]! : '.');

export function findingKey(f: { file: string; bin: string; flag?: string }): string {
  return f.flag ? `${f.file}:${f.bin}:${f.flag}` : `${f.file}:${f.bin}`;
}

function findingsFor(calls: BinCall[], profiles: Map<string, BinProfile>): Finding[] {
  const out: Finding[] = [];
  for (const call of calls) {
    const profile = profiles.get(call.bin)!;
    const make = (code: DriftCode, flag?: string): Finding => {
      const base = { code, file: call.file, line: call.line, bin: call.bin, flag };
      return { ...base, key: findingKey(base), fix: FIX_LINE };
    };
    if (!profile.exists) { out.push(make('DRIFT_UNKNOWN_BIN')); continue; }
    if (!profile.flagsKnown) continue;
    for (const flag of call.flags) if (!profile.flags.has(flag)) out.push(make('DRIFT_UNKNOWN_FLAG', flag));
  }
  return out;
}

/** Drop render findings whose skill's own templates already report the same bin and flag. */
function dropRenderEchoes(findings: Finding[]): Finding[] {
  const id = (f: Finding) => `${skillDirOf(f.file)}|${f.code}|${f.bin}|${f.flag ?? ''}`;
  const fromTemplates = new Set(findings.filter(f => isTemplate(f.file)).map(id));
  return findings.filter(f => isTemplate(f.file) || !fromTemplates.has(id(f)));
}

/** Scan a repository root (or a fixture laid out like one). */
export function scanRepo(root: string, inputs: string[] = listInputs(root)): DriftReport {
  const calls = inputs.flatMap(file => scanText(readText(path.join(root, file)), file));
  const built = builtPatterns(root);
  const profiles = new Map<string, BinProfile>();
  for (const call of calls) if (!profiles.has(call.bin)) profiles.set(call.bin, profileBin(root, call.bin, built));
  const seen = new Set<string>();
  const findings = dropRenderEchoes(findingsFor(calls, profiles)).filter(f => {
    const id = `${f.key}|${f.line}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.key.localeCompare(b.key));
  const existing = [...profiles.values()].filter(p => p.exists).sort((a, b) => a.bin.localeCompare(b.bin));
  return {
    inputs,
    calls,
    findings,
    binsInvoked: [...profiles.keys()].sort(),
    permissive: existing.filter(p => p.permissive).map(p => p.bin),
    noHelp: existing.filter(p => p.flagsKnown && !p.hasHelp).map(p => p.bin),
    unchecked: existing.filter(p => !p.flagsKnown).map(p => p.bin),
  };
}

export interface Allowlist { _comment?: string; entries: string[] }

export function loadAllowlist(file: string): Allowlist {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Allowlist;
  if (!Array.isArray(parsed.entries)) throw new Error(`${file}: "entries" must be an array of finding keys`);
  return parsed;
}

/** Findings the allowlist does not cover, and allowlist keys (for the scanned inputs, when given) that no longer reproduce. */
export function compareAllowlist(findings: Finding[], allowlist: Allowlist, inputs?: string[]): { unlisted: Finding[]; stale: string[] } {
  const allowed = new Set(allowlist.entries);
  const live = new Set(findings.map(f => f.key));
  const scanned = (key: string) => !inputs || inputs.some(file => key.startsWith(`${file}:`));
  return {
    unlisted: findings.filter(f => !allowed.has(f.key)),
    stale: allowlist.entries.filter(k => scanned(k) && !live.has(k)),
  };
}

export function formatFinding(f: Finding): string {
  const what = f.code === 'DRIFT_UNKNOWN_BIN' ? `bin/${f.bin} does not exist` : `${f.bin} does not accept ${f.flag}`;
  return `${f.code} ${f.file}:${f.line} bin=${f.bin}${f.flag ? ` flag=${f.flag}` : ''}: ${what}\n  fix: ${f.fix}`;
}

const HELP = `Usage: scripts/skill-bin-drift.ts [--skill NAME] [--json] [--all] [--root DIR]

Statically checks every gstack bin that skill templates, carved sections and
Claude-host renders invoke: the bin must exist in bin/ and every --flag passed
to it must appear in its parser (bash case arms or comparisons, TS/JS/Python
flag literals one relative import deep, bash hand-offs to .ts/.js/.py/.sh).
Never executes a bin.

  --skill NAME  scan only NAME/: its template, sections, references and
                Claude render (stale allowlist entries are judged for those
                files only)
  --json        print the report as JSON
  --all         list every finding, allowlisted ones included
  --root DIR    scan DIR instead of this checkout
  --help        show this help

Exit codes: 0 no finding outside ${ALLOWLIST_FILE} and no stale entry;
1 drift outside the allowlist or a stale allowlist entry; 2 bad usage.
PERMISSIVE, NO_HELP and UNCHECKED bins are reported, never failed.`;

interface CliOptions { json: boolean; all: boolean; root: string; skill?: string }

function parseCli(argv: string[]): CliOptions | string {
  const opts: CliOptions = { json: false, all: false, root: path.resolve(import.meta.dir, '..') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') opts.json = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--root' || a === '--skill') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return `${a} needs a value`;
      if (a === '--root') opts.root = path.resolve(v);
      else opts.skill = v.replace(/\/+$/, '');
    } else return `unknown argument ${a}`;
  }
  if (opts.skill && listInputs(opts.root, opts.skill).length === 0) {
    return `no skill named ${opts.skill} under ${opts.root} (expected ${opts.skill}/SKILL.md.tmpl or ${opts.skill}/SKILL.md)`;
  }
  return opts;
}

function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0; }
  const opts = parseCli(argv);
  if (typeof opts === 'string') { console.error(`skill-bin-drift: ${opts}\n\n${HELP}`); return 2; }
  const report = scanRepo(opts.root, listInputs(opts.root, opts.skill));
  const allowFile = path.join(opts.root, ALLOWLIST_FILE);
  const allowlist = isFile(allowFile) ? loadAllowlist(allowFile) : { entries: [] };
  const { unlisted, stale } = compareAllowlist(report.findings, allowlist, opts.skill ? report.inputs : undefined);
  const unknownBins = report.findings.filter(f => f.code === 'DRIFT_UNKNOWN_BIN').length;
  if (opts.json) {
    console.log(JSON.stringify({
      inputs: report.inputs.length, calls: report.calls.length, binsInvoked: report.binsInvoked.length,
      unknownBins, unknownFlags: report.findings.length - unknownBins,
      findings: report.findings, unlisted: unlisted.map(f => f.key), stale,
      permissive: report.permissive, noHelp: report.noHelp, unchecked: report.unchecked,
    }, null, 2));
  } else {
    for (const f of opts.all ? report.findings : unlisted) console.log(formatFinding(f));
    for (const key of stale) console.log(`STALE_ALLOWLIST ${key}: no longer reproduces; delete it from ${ALLOWLIST_FILE}`);
    console.log(`PERMISSIVE (${report.permissive.length}): ${report.permissive.join(' ') || 'none'}`);
    console.log(`NO_HELP (${report.noHelp.length}): ${report.noHelp.join(' ') || 'none'}`);
    console.log(`UNCHECKED (${report.unchecked.length}): ${report.unchecked.join(' ') || 'none'}`);
    console.log(`skill-bin-drift: ${report.inputs.length} inputs, ${report.calls.length} calls, ${report.binsInvoked.length} bins, `
      + `${unknownBins} unknown-bin and ${report.findings.length - unknownBins} unknown-flag findings `
      + `(${unlisted.length} outside the allowlist, ${stale.length} stale entries)`);
  }
  return unlisted.length > 0 || stale.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
