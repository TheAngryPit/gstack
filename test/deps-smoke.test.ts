/**
 * Dependency-override smoke tests (v1.78.0.0 dependency wave).
 *
 * The wave's `overrides` entries (package.json: ip-address 10.7.4 (raised
 * from 10.3.1 for GHSA-2vr4/h3mg/j6r3/rpw4, then 10.7.3 for GHSA-rxp7, Oct 2026),
 * sharp 0.35.0; lib/diagram-render: nanoid 5.x, lodash-es 4.18.x) defeat
 * nested exact pins, so a green unit suite alone does not prove the forced
 * versions actually work for their consumers. These smokes exercise the
 * overridden surfaces directly. SOCKS is covered by
 * browse/test/socks-bridge.test.ts; the diagram bundle by
 * test/diagram-render-drift.test.ts + the paid diagram E2E.
 */
import { describe, expect, test } from "bun:test";

describe("dependency-wave smoke", () => {
  test("sharp 0.35 override: import + metadata + resize round-trip", async () => {
    const sharp = (await import("sharp")).default;
    // 1x1 red PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(1);
    const out = await sharp(png).resize(4, 4).png().toBuffer();
    const outMeta = await sharp(out).metadata();
    expect(outMeta.width).toBe(4);
  });

  test("ip-address 10.7.4 override: both nested consumers resolve the fixed version", async () => {
    const lock = await Bun.file(`${import.meta.dir}/../bun.lock`).text();
    // No vulnerable ip-address node may survive anywhere in the tree
    // (socks pulled 10.2.0; express-rate-limit exact-pinned 10.1.0 — the
    // override must defeat both), and 10.7.3 (GHSA-rxp7-6hxx-x8q5) is vulnerable too.
    expect(lock).not.toMatch(/ip-address@10\.[0-6]\./);
    expect(lock).not.toMatch(/ip-address@10\.7\.[0-3]"/);
    expect(lock).toMatch(/ip-address@10\.7\.(?:[4-9]|\d{2,})/);
  });

  // The 2026-10-26 OSV scan (#3462) named the fixed release of each package
  // below; a lockfile that resolves any of them lower regresses the scan.
  const floors: Array<[lockfile: string, pkg: string, min: string]> = [
    ["bun.lock", "@modelcontextprotocol/sdk", "1.32.0"],
    ["bun.lock", "fast-uri", "3.1.9"],
    ["bun.lock", "ip-address", "10.7.4"],
    ["bun.lock", "zod", "4.6.6"],
    ["bun.lock", "body-parser", "2.4.0"],
    ["lib/diagram-render/bun.lock", "dompurify", "3.4.17"],
  ];
  const cmp = (a: string, b: string) => {
    const [x, y] = [a, b].map(v => v.split(".").map(Number));
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  };
  test.each(floors)("%s resolves every %s at or above its OSV-fixed release %s", async (lockfile, pkg, min) => {
    const lock = await Bun.file(`${import.meta.dir}/../${lockfile}`).text();
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const resolved = [...lock.matchAll(new RegExp(`"${escaped}@(\\d+\\.\\d+\\.\\d+)"`, "g"))].map(m => m[1]);
    expect(resolved.length).toBeGreaterThan(0);
    for (const v of resolved) expect(cmp(v, min), `${pkg}@${v} is below ${min}`).toBeGreaterThanOrEqual(0);
  });

  test("marked stays importable and parses (direct-dep bump)", async () => {
    const { marked } = await import("marked");
    const html = await marked.parse("**b**");
    expect(html).toContain("<strong>b</strong>");
  });
});
