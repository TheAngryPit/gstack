#!/usr/bin/env node
import { spawn } from "node:child_process";

if (process.argv.includes("--per-file")) {
  let diff = "";
  process.stdin.setEncoding("utf8");
  for await (const part of process.stdin) diff += part;
  const sections = diff.split(/(?=^diff --git )/m);
  const limit = 8 * 1024 * 1024;
  let batch = "";
  let bytes = 0;
  let failed = false;
  const scan = (input) => new Promise((resolve) => {
    const scanner = spawn(process.execPath, [import.meta.filename], {
      shell: false, windowsHide: true, stdio: ["pipe", "inherit", "inherit"],
    });
    scanner.stdin.on("error", (error) => { if (error.code !== "EPIPE") failed = true; });
    scanner.once("error", () => { failed = true; resolve(); });
    scanner.once("close", (code) => { if (code !== 0) failed = true; resolve(); });
    scanner.stdin.end(input);
  });
  for (const section of sections) {
    const size = Buffer.byteLength(section.split(/\r?\n/)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1)).join("\n"));
    if (batch && bytes + size > limit) {
      await scan(batch);
      batch = "";
      bytes = 0;
    }
    batch += section;
    bytes += size;
  }
  await scan(batch);
  process.exitCode = failed ? 1 : 0;
} else {
const child = spawn("bun", [
  "bin/gstack-redact",
  "--repo-visibility", "public",
  "--json",
  "--max-bytes", "16000000",
], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
let diff = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { diff += chunk; });
process.stdin.once("end", () => {
  const additions = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  // The scanner may exit before consuming an oversize payload (it refuses
  // stdin over --max-bytes and reports oversize:true). EPIPE here is that
  // refusal in flight, not a failure — the report + exit code carry the verdict.
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
  });
  child.stdin.end(additions);
});
let stdout = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.once("error", (error) => { throw error; });
child.once("close", (code) => {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    // No parseable report: the oversize refusal prints only to stderr and
    // exits 3, and a crashed scanner emits nothing. Both fail closed.
    console.log(`credential scan: 1 high, 0 advisory (scanner emitted no report, exit ${code} — fail-closed)`);
    process.exitCode = 1;
    return;
  }
  const high = Number(report.counts?.HIGH ?? 0);
  const medium = Number(report.counts?.MEDIUM ?? 0);
  console.log(`credential scan: ${high} high, ${medium} advisory`);
  process.exitCode = high > 0 || report.oversize || ![0, 2, 3].includes(code) ? 1 : 0;
});

}
