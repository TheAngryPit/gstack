/**
 * pregate version-stamp-only — a release manifest whose diff against the base
 * changes nothing but its version values needs no test lane.
 *
 * gbrain's `release:restamp` rewrites six plugin manifests, its VERSION file
 * and package.json; its base's `.gstack/pregate.json` declares no lane for
 * them, and pregate reads policy from the base, so every stamp PR failed
 * `lanes` with `PREGATE_NO_LANE` and the PR could not fix itself (gbrain #7625,
 * #7606). A stamp changes no behaviour a test could observe, so `lanes` waives
 * such a file, naming it and why, when `versionStampOnly` says the before and
 * after texts differ only as a stamp does.
 *
 * The rule is deliberately narrow. Three file kinds, each with its own exact
 * definition; anything else, a parse failure, a file absent on either side,
 * or an unchanged file is not stamp-only, and the caller falls through to
 * `PREGATE_NO_LANE` as before:
 *
 * - JSON (`*.json`): both texts parse to objects of the same shape (the same
 *   own keys in the same order in every object, the same length in every
 *   array, the same type at every leaf); the only differing leaf is the
 *   document's top-level `version`, a bare version string on both sides
 *   (`VERSION_TOKEN`: `1.2.3`, `v1.2.3.4`, `1.2.3-rc.1`); and the two texts
 *   are line-for-line identical once that one changed line has its old quoted
 *   version replaced by the new one. Nothing nested qualifies, so a dependency
 *   pin or range, a lockfile entry, a catalog, a devcontainer feature option
 *   or a package named `version` is never a stamp; nor is a changed
 *   description, a new, removed or reordered key, a floor such as
 *   `minHostVersion` or `schemaVersion`, a reflow, a document nested too deep
 *   to walk, or any change the parser would erase (a big integer, a
 *   duplicate key).
 * - plist (`*.plist`): the same number of lines; every differing line pair is
 *   a `<string>` holding a bare version on both sides, and the line before it
 *   is `<key>CFBundleShortVersionString</key>` or `<key>CFBundleVersion</key>`.
 *   `MinimumOSVersion` and every other key are not stamps.
 * - VERSION files (basename `VERSION` or `VERSION.txt`, any case): the whole
 *   content is one bare version, with at most a trailing LF, on both sides
 *   (a BOM, a space, a CR or a second line is not).
 *
 * Texts are compared as they are: a line-ending change, a BOM or any other
 * byte the parser would hide is content, and is not a stamp.
 *
 * Applied by lib/pregate/lane-selection.ts only after the import graph, the
 * declarations, the regen registry and the two empty-lane classes found
 * nothing, so a manifest a test reads still selects that test; only to a
 * modified, unrenamed file; and never under a test, fixture, golden, snapshot,
 * `.gstack/` or CI-workflow tree, whose JSON a test may compare against by a
 * path the import graph cannot see. The verdict is per file: the other touched files
 * keep their own lanes or their own `PREGATE_NO_LANE`.
 */

/** A bare version: optional `v`, two to four dot-separated numbers, an optional pre-release or build suffix. No range operators. */
export const VERSION_TOKEN = /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;
/** The one JSON key a stamp may change, at the document root only. */
const JSON_VERSION_KEY = 'version';
/** The plist keys a stamp may change. */
const PLIST_VERSION_KEYS = new Set(['CFBundleShortVersionString', 'CFBundleVersion']);
const VERSION_FILE = /^VERSION(?:\.txt)?$/i;
const PLIST_STRING = /^\s*<string>([^<]*)<\/string>\s*$/;
const PLIST_KEY = /^\s*<key>([^<]*)<\/key>\s*$/;

export type StampVerdict = { stampOnly: true; changed: string[] } | { stampOnly: false; reason: string };

const not = (reason: string): StampVerdict => ({ stampOnly: false, reason });

/** Which definition applies to `rel`; null when none does. */
export function stampFileKind(rel: string): 'json' | 'plist' | 'version' | null {
  const base = rel.replace(/\\/g, '/').split('/').pop() ?? rel;
  if (VERSION_FILE.test(base)) return 'version';
  if (/\.json$/i.test(base)) return 'json';
  if (/\.plist$/i.test(base)) return 'plist';
  return null;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface VersionChange { path: string; from: string; to: string }

function kindOf(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

const isObject = (v: Json): v is { [k: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Walks `a` and `b` together. `key` is the own key `a` sits under (null at the
 * root and inside arrays), `at` the display path, `depth` how many containers
 * enclose it (1 for a root object's own values). Returns the first structural
 * difference as a reason, or null after recording the version change.
 */
function jsonDiff(a: Json, b: Json, key: string | null, at: string, depth: number, changed: VersionChange[]): string | null {
  const here = at || '$';
  if (kindOf(a) !== kindOf(b)) return `${here} changed type (${kindOf(a)} → ${kindOf(b)})`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${here} changed length (${a.length} → ${b.length})`;
    for (let i = 0; i < a.length; i++) { const r = jsonDiff(a[i]!, b[i]!, null, `${at}[${i}]`, depth + 1, changed); if (r) return r; }
    return null;
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a); const kb = Object.keys(b);
    for (const k of ka) if (!Object.hasOwn(b, k)) return `${at}.${k} removed`;
    for (const k of kb) if (!Object.hasOwn(a, k)) return `${at}.${k} added`;
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return `${here} keys reordered (${ka[i]} → ${kb[i]} at position ${i})`;
    for (const k of ka) { const r = jsonDiff(a[k]!, b[k]!, k, `${at}.${k}`, depth + 1, changed); if (r) return r; }
    return null;
  }
  if (a === b) return null;
  if (typeof a !== 'string' || typeof b !== 'string') return `${here} changed and is not a version string`;
  if (key !== JSON_VERSION_KEY) return `${here} changed and its key is not \`${JSON_VERSION_KEY}\``;
  if (depth !== 1) return `${here} changed and is not the top-level \`${JSON_VERSION_KEY}\``;
  if (!VERSION_TOKEN.test(a) || !VERSION_TOKEN.test(b)) return `${here} changed and a value is not a bare version (${JSON.stringify(a)} → ${JSON.stringify(b)})`;
  changed.push({ path: at.replace(/^\./, ''), from: a, to: b });
  return null;
}

/**
 * The texts must differ on exactly one line per recorded version change, each
 * such line being the old line with that change's old quoted version replaced
 * by the new one, each change consumed once. Rejects what the parser erased:
 * reflow, a shadowed duplicate key, number spellings, escape spellings.
 */
function textDiffersOnlyByVersions(a: string, b: string, changed: readonly VersionChange[]): string | null {
  const la = a.split('\n'); const lb = b.split('\n');
  if (la.length !== lb.length) return `line count changed (${la.length} → ${lb.length})`;
  const unused = [...changed];
  for (let i = 0; i < la.length; i++) {
    if (la[i] === lb[i]) continue;
    const k = unused.findIndex(c => la[i]!.includes(JSON.stringify(c.from)) && la[i]!.replace(JSON.stringify(c.from), JSON.stringify(c.to)) === lb[i]);
    if (k < 0) return `line ${i + 1} changed beyond a version value`;
    unused.splice(k, 1);
  }
  return unused.length ? `${unused[0]!.path} changed in the document but on no line of its own` : null;
}

/**
 * Whether `rel` changed from `before` to `after` as a version stamp and nothing
 * else, per the file-kind definitions above. `before` is the file's text at the
 * merge base, `after` its working-tree text; null on either side (absent,
 * unreadable, not valid UTF-8, or over the caller's size cap) is never a stamp.
 */
export function versionStampOnly(rel: string, before: string | null, after: string | null): StampVerdict {
  const kind = stampFileKind(rel);
  if (!kind) return not('not a JSON, plist or VERSION file');
  if (after === null) return not('absent or unreadable in the working tree');
  if (before === null) return not('absent or unreadable at the merge base');
  const a = before; const b = after;
  if (a === b) return not('unchanged');
  if (kind === 'version') {
    const x = a.replace(/\n$/, ''); const y = b.replace(/\n$/, '');
    if (!VERSION_TOKEN.test(x) || !VERSION_TOKEN.test(y)) return not('content is not one bare version on both sides');
    if (x === y) return not('no version changed (trailing newline only)');
    return { stampOnly: true, changed: [`${x} → ${y}`] };
  }
  if (kind === 'plist') {
    const la = a.split('\n'); const lb = b.split('\n');
    if (la.length !== lb.length) return not(`line count changed (${la.length} → ${lb.length})`);
    const changed: string[] = [];
    for (let i = 0; i < la.length; i++) {
      if (la[i] === lb[i]) continue;
      const ma = PLIST_STRING.exec(la[i]!); const mb = PLIST_STRING.exec(lb[i]!);
      if (!ma || !mb) return not(`line ${i + 1} changed and is not a <string> value`);
      if (!VERSION_TOKEN.test(ma[1]!) || !VERSION_TOKEN.test(mb[1]!)) return not(`line ${i + 1} changed and a value is not a bare version`);
      const key = i > 0 ? PLIST_KEY.exec(la[i - 1]!)?.[1] : undefined;
      if (key === undefined || !PLIST_VERSION_KEYS.has(key)) return not(`line ${i + 1} changed under ${key === undefined ? 'no <key>' : `<key>${key}</key>`}, not a bundle version key`);
      changed.push(`${key} ${ma[1]} → ${mb[1]}`);
    }
    return changed.length ? { stampOnly: true, changed } : not('no line changed');
  }
  let ja: Json; let jb: Json;
  try { ja = JSON.parse(a); jb = JSON.parse(b); } catch (e) { return not(`not parseable JSON on both sides (${(e as Error).message})`); }
  if (!isObject(ja) || !isObject(jb)) return not('not a JSON object on both sides');
  const changed: VersionChange[] = [];
  let reason: string | null;
  try { reason = jsonDiff(ja, jb, null, '', 0, changed); } catch (e) { return not(`could not compare (${e instanceof RangeError ? 'nested too deep' : (e as Error).message})`); }
  reason ??= changed.length ? textDiffersOnlyByVersions(a, b, changed) : 'no value changed (whitespace or spelling only)';
  if (reason) return not(reason);
  return { stampOnly: true, changed: changed.map(c => `${c.path} ${c.from} → ${c.to}`) };
}
