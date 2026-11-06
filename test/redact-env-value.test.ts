/**
 * The engine's env-value scan (GSTA-104): a credential already in the process
 * environment (*_KEY, *_TOKEN, *_SECRET, *_PASSWORD) is a HIGH finding wherever
 * its VALUE appears in the scanned text, whatever shape it has. During GSTA-96's
 * unattended /ship, a docs-audit child re-typed the launch assignments as
 * `export $(...)`; the substitution came back empty, the bare `export` printed
 * the whole environment, and three API key values sat in a tool output that any
 * later writer (PR body, receipt, report, Drive mirror) could have quoted. Every
 * writer scans through this engine, so the value itself is now what it refuses.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { NON_SECRET_ENV_NAMES, credentialEnvValues, redactFindingSpans, scan } from "../lib/redact-engine";

// Fixture values live in plain constants: a credential-named assignment with an
// entropic literal on one line is exactly what the repo's own pregate secrets
// scan (env.kv) refuses in added lines.
const anthropicValue = "zq7Vm2pL9xR4tW8yB3nK6hJ1";
const ubicloudValue = "ubi-plain-looking-value-0042";
const ghValue = "f0a9c2e1d7b6";
const dbValue = "hunter2hunter2";
const awsSecretValue = "s3cr3t-s3cr3t-s3cr3t";
const dbPasswdValue = "passwd-passwd-passwd";
const lowerCaseValue = "lower-case-name-value";
const monkeyValue = "banana-banana-banana";
const tokenizerValue = "tokenizer-value-here";
const lockOwner = ["12345", "6789", "17"].join("-");
const slashSecret = "/Qm9vZ2llV29vZ2ll/abc123XYZ+=";
const sslKeyPath = "/etc/ssl/private/x.key";

const env = {
  ANTHROPIC_API_KEY: anthropicValue,
  UBICLOUD_API_KEY: ubicloudValue,
  GH_TOKEN: ghValue,
  DB_PASSWORD: dbValue,
  SHORT_KEY: "abc",
  PLACEHOLDER_TOKEN: "your-token-here",
  HOME: "/home/user/with/enough/length",
  GSTACK_STATE_ROOT: "/home/user/.gstack",
  GSTACK_LAUNCH_FILE: "/home/user/.gstack/install-verdicts/a/b.env",
};

describe("env-value scan", () => {
  test("picks only credential-named variables with credential-sized, non-placeholder values", () => {
    const names = credentialEnvValues(env).map(e => e.name).sort();
    expect(names).toEqual(["ANTHROPIC_API_KEY", "DB_PASSWORD", "GH_TOKEN", "UBICLOUD_API_KEY"]);
    // /ship Step 7 value card. protects: the name filter is a suffix WORD (_KEY, _TOKEN, _SECRET,
    // _PASSWORD, _PASSWD, any case), not a suffix string, and an unset or whitespace-padded short
    // value is never scanned for. fails_when: the (^|_) anchor is dropped (MONKEY's value becomes a
    // HIGH finding and blocks a clean PR body), SECRET/PASSWD/lowercase names stop being scanned (a
    // leaked AWS_SECRET passes), or the trim guard goes (a padded 7-character value matches prose).
    // why_existing_misses: the table above holds only *_KEY/*_TOKEN/*_PASSWORD upper-case names and
    // no undefined or padded value. seam=none.
    const edges = {
      AWS_SECRET: awsSecretValue, DB_PASSWD: dbPasswdValue, api_key: lowerCaseValue,
      MONKEY: monkeyValue, TOKENIZER: tokenizerValue, UNSET_KEY: undefined, PADDED_KEY: "   abcdefg   ", EIGHT_KEY: "12345678",
    };
    expect(credentialEnvValues(edges).map(e => e.name).sort()).toEqual(["AWS_SECRET", "DB_PASSWD", "EIGHT_KEY", "api_key"]);
    expect(scan(`monkeys: ${monkeyValue}; tokens: ${tokenizerValue}`, { processEnv: edges }).findings.filter(f => f.id === "env.value")).toEqual([]);
  });

  // /ship Step 7 value card. protects: the value is matched on the NORMALIZED text (the engine's
  // documented first rule), so a credential split by a zero-width character or re-typed in
  // fullwidth forms is still an env.value finding, and the span maps back to the original bytes so
  // redaction removes the whole value, zero-width filler included. fails_when: the loop matches
  // `input` instead of `normalized`, or the span end is taken from the normalized offset.
  // why_existing_misses: every value above appears verbatim in ASCII. seam=none.
  test("a value split by a zero-width character or written in fullwidth forms is still found, and redaction removes the original bytes", () => {
    const split = `${anthropicValue.slice(0, 6)}\u200b${anthropicValue.slice(6)}`;
    const text = `leak: ${split} end`;
    expect(scan(text, { processEnv: env }).findings.map(f => [f.id, f.line, f.col])).toEqual([["env.value", 1, 7]]);
    const redacted = redactFindingSpans(text, { processEnv: env });
    expect(redacted).toBe("leak: <REDACTED-env.value> end");
    const fullwidth = anthropicValue.replace(/[0-9A-Za-z]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    expect(fullwidth).not.toBe(anthropicValue);
    expect(scan(`x ${fullwidth} y`, { processEnv: env }).findings.map(f => f.id)).toEqual(["env.value"]);
  });

  test("a dumped environment line is HIGH by value, whatever the value's shape", () => {
    const text = [
      "Tool output:",
      `ANTHROPIC_API_KEY=${anthropicValue}`,
      "GSTACK_STATE_ROOT=/home/user/.gstack",
      `the cloud key is ${ubicloudValue} and nothing else`,
    ].join("\n");
    const result = scan(text, { processEnv: env });
    const envFindings = result.findings.filter(f => f.id === "env.value");
    expect(envFindings.map(f => [f.line, f.description])).toEqual([
      [2, "Value of the ANTHROPIC_API_KEY environment variable"],
      [4, "Value of the UBICLOUD_API_KEY environment variable"],
    ]);
    for (const f of envFindings) {
      expect(f.severity).toBe("HIGH");
      expect(f.category).toBe("secret");
      expect(f.preview).not.toContain(anthropicValue);
      expect(f.preview).not.toContain(ubicloudValue);
    }
    expect(result.counts.HIGH).toBeGreaterThanOrEqual(2);
  });

  test("a variable's path-shaped non-credential value and the launch file path are not findings", () => {
    const text = "GSTACK_STATE_ROOT=/home/user/.gstack GSTACK_LAUNCH_FILE=/home/user/.gstack/install-verdicts/a/b.env HOME=/home/user/with/enough/length";
    expect(scan(text, { processEnv: env }).findings.filter(f => f.id === "env.value")).toEqual([]);
  });

  test("the allowlist suppresses a value, and an empty environment scans nothing by value", () => {
    const text = `token ${ghValue} here`;
    expect(scan(text, { processEnv: env }).findings.map(f => f.id)).toContain("env.value");
    expect(scan(text, { processEnv: env, allowlist: [ghValue] }).findings.filter(f => f.id === "env.value")).toEqual([]);
    expect(scan(text, { processEnv: {} }).findings.filter(f => f.id === "env.value")).toEqual([]);
  });

  test("redactFindingSpans removes the value bytes for machine egress", () => {
    const text = `key=${anthropicValue}; password ${dbValue} twice: ${dbValue}`;
    const redacted = redactFindingSpans(text, { processEnv: env });
    expect(redacted).not.toBeNull();
    expect(redacted).not.toContain(anthropicValue);
    expect(redacted).not.toContain(dbValue);
    expect(redacted).toContain("<REDACTED-env.value>");
  });

  // /ship Step 9.4 review fixes, each pinned: (1) a value whose env copy carries a trailing newline
  // (a key read from a file) is searched for TRIMMED, so its leaked form still matches; (2) when one
  // value is a prefix of another, both are findings and the longer value is redacted whole, in either
  // order (the dedup key carries the length, not the offset alone); (3) the preview never shows any
  // byte of a live value; (4) a framework-public name (NEXT_PUBLIC_*_KEY, *_PUBLIC_KEY) is not
  // scanned, since that value is committed on purpose. fails_when: the trim moves back to the
  // length check only, the dedup key drops the length, maskPreview returns, or the PUBLIC exclusion goes.
  test("a padded value, a prefix value, the preview and PUBLIC-named variables", () => {
    const padded = { FILE_KEY: `${anthropicValue}\n` };
    expect(scan(`leak: ${anthropicValue} end`, { processEnv: padded }).findings.map(f => f.id)).toEqual(["env.value"]);
    const short = anthropicValue.slice(0, 12);
    const text = `leak: ${anthropicValue} end`;
    for (const order of [{ A_KEY: short, B_KEY: anthropicValue }, { B_KEY: anthropicValue, A_KEY: short }]) {
      expect(scan(text, { processEnv: order }).findings.map(f => f.description).sort()).toEqual([
        "Value of the A_KEY environment variable", "Value of the B_KEY environment variable",
      ]);
      expect(redactFindingSpans(text, { processEnv: order })).toBe("leak: <REDACTED-env.value> end");
    }
    const preview = scan(text, { processEnv: env }).findings.find(f => f.id === "env.value")?.preview ?? "";
    expect(preview).toBe("********");
    expect(scan(`pk: ${monkeyValue}`, { processEnv: { NEXT_PUBLIC_STRIPE_KEY: monkeyValue, APP_PUBLIC_KEY: monkeyValue } }).findings).toEqual([]);
    expect(credentialEnvValues({ PUBLICITY_KEY: monkeyValue }).map(e => e.name)).toEqual(["PUBLICITY_KEY"]);
  });

  // (1) the name rule also admits *_PASS, *_PAT, *_APIKEY and *_PWD, while the shell's own PWD and
  // OLDPWD stay out by NAME (their fixture values are plain words, so only the name rule keeps them
  // out); (2) there is no path exemption: a path-valued SSL_KEY and a base64 secret starting with
  // "/" are both scanned, and a directory path as a value changes nothing (an existence check
  // let the scanned agent exempt a value by creating a path of that name); (3) gstack's own
  // GSTACK_BRAIN_LOCK_TOKEN (pid-random-epoch, written to the lock owner file) is not a secret, and
  // bin/gstack-brain-lock.sh still exports every name in that set; (4) a value NFKC rewrites
  // (fullwidth digits) is matched in its normalized form, so its leaked ASCII form is found, and a
  // value whose normalized form is under eight characters, or a placeholder, is not searched for,
  // and the allowlist suppresses by normalized form as well.
  // fails_when: PWD is admitted (every mention of the cwd becomes HIGH), a shape or existence rule
  // returns (the slash secret or the directory value is skipped), the non-secret set drifts, or the
  // value is matched raw against the normalized text.
  test("more credential suffixes, no path exemption, gstack's own lock token and a normalized value", () => {
    const names = credentialEnvValues({
      DB_PASS: dbValue, GITHUB_PAT: ghValue, STRIPE_APIKEY: lowerCaseValue, MYSQL_PWD: dbPasswdValue,
      PWD: "workspace-dir-name", OLDPWD: "previous-dir-name",
      SSL_KEY: sslKeyPath, DIR_KEY: "/usr/local/share/ca-certificates", SLASH_KEY: slashSecret,
      GSTACK_BRAIN_LOCK_TOKEN: lockOwner,
    }).map(e => e.name).sort();
    expect(names).toEqual(["DB_PASS", "DIR_KEY", "GITHUB_PAT", "MYSQL_PWD", "SLASH_KEY", "SSL_KEY", "STRIPE_APIKEY"]);
    expect(scan(`b64 ${slashSecret}`, { processEnv: { SLASH_KEY: slashSecret } }).findings.map(f => f.id)).toEqual(["env.value"]);
    const lock = fs.readFileSync(path.join(import.meta.dir, "..", "bin", "gstack-brain-lock.sh"), "utf8");
    for (const name of NON_SECRET_ENV_NAMES) expect(lock, name).toContain(`export ${name}`);
    const fullwidth = anthropicValue.replace(/[0-9]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    expect(fullwidth).not.toBe(anthropicValue);
    expect(scan(`leak: ${anthropicValue} end`, { processEnv: { WIDE_KEY: fullwidth } }).findings.map(f => f.id)).toEqual(["env.value"]);
    const zeroWidthPadded = "ab\u200bcd\u200bef\u200bg";
    expect(scan("plain abcdefg here", { processEnv: { ZW_KEY: zeroWidthPadded } }).findings).toEqual([]);
    // The allowlist and the placeholder rule see the normalized form too: an allowlisted ASCII form
    // suppresses the fullwidth value, and a value that is a placeholder only after NFKC is not searched.
    expect(scan(`leak: ${anthropicValue} end`, { processEnv: { WIDE_KEY: fullwidth }, allowlist: [anthropicValue] }).findings).toEqual([]);
    const widePlaceholder = "your-token-here".replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    expect(scan("x your-token-here y", { processEnv: { P_TOKEN: widePlaceholder } }).findings.filter(f => f.id === "env.value")).toEqual([]);
  });

  test("the default environment is process.env", () => {
    const name = "GSTA104_TEST_TOKEN";
    process.env[name] = "v4lue-only-this-test-knows";
    try {
      const found = scan("leaked: v4lue-only-this-test-knows").findings.find(f => f.id === "env.value");
      expect(found?.description).toBe(`Value of the ${name} environment variable`);
    } finally {
      delete process.env[name];
    }
  });
});
