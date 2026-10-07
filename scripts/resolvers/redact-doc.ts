/**
 * redact-doc — resolvers for the shared redaction docs + invocation bash.
 *
 *   {{REDACT_TAXONOMY_TABLE}}            → markdown table of the 3-tier taxonomy,
 *                                          derived from lib/redact-patterns so /spec
 *                                          and /cso never drift from the engine.
 *   {{REDACT_INVOCATION_BLOCK:<sink>}}   → the canonical scan-at-sink bash + prose
 *                                          for one enforcement point. <sink> is a
 *                                          hyphenated label: pre-codex, pre-issue,
 *                                          pre-archive, pre-pr-body, pre-pr-title,
 *                                          pre-commit.
 *
 * DRY: every skill writes one placeholder per enforcement point; UX/threshold
 * changes land here once. test/redact-doc-resolver.test.ts golden-pins the output.
 */
import { toShellPath, type TemplateContext } from './types';
import { FREE_TEXT_DIR } from './free-text-file';

interface SinkSpec {
  /** What is being scanned, for the prose. */
  noun: string;
  /** What HIGH blocks, in this skill's verbs. */
  blockVerb: string;
}

const SINKS: Record<string, SinkSpec> = {
  'pre-codex': { noun: 'the spec body', blockVerb: 'dispatch to the outside reviewer' },
  'pre-issue': { noun: "the issue body you're about to file", blockVerb: 'file the issue' },
  'pre-archive': { noun: 'the body about to be archived', blockVerb: 'write the archive' },
  'pre-pr-body': { noun: 'the composed PR body', blockVerb: 'create/edit the PR' },
  'pre-pr-title': { noun: 'the PR title', blockVerb: 'set the PR title' },
  'pre-commit': { noun: 'the generated docs about to be committed', blockVerb: 'commit' },
};

export function generateRedactInvocationBlock(ctx: TemplateContext, args?: string[]): string {
  const sinkLabel = args?.[0] ?? 'pre-issue';
  const brief = args?.[1] === 'brief';
  const sink = SINKS[sinkLabel] ?? SINKS['pre-issue'];
  const bin = `${ctx.paths.binDir}/gstack-redact`;
  const outsideGate = sinkLabel === 'pre-codex';
  const scan = `REDACT_JSON=$(${outsideGate ? `"${toShellPath(bin)}"` : bin} --from-file "$REDACT_FILE" --repo-visibility "$REDACT_VIS" --self-email "$(git config user.email 2>/dev/null)" --json)`;
  // This sink can dispatch a model and then publish/archive the same spec.
  // Keep its stop decision in executable shell, even when the caller runs
  // without errexit. MEDIUM must pause for its existing user decision.
  const scanAndGate = outsideGate ? `if ${scan}; then REDACT_CODE=0; else REDACT_CODE=$?; fi
case "$REDACT_CODE" in
  0) ;; # Only a successful scan may reach an outside or downstream sink.
  2)
    printf '%s\\n' "$REDACT_JSON"
    printf 'REDACT_FILE: %s\\n' "$REDACT_FILE"
    echo 'Redaction requires the MEDIUM disposition below; outside dispatch and downstream persistence are paused.' >&2
    exit 2 ;;
  3)
    printf '%s\\n' "$REDACT_JSON"
    rm -f "$REDACT_FILE"
    echo 'HIGH redaction finding: outside dispatch and downstream persistence blocked. Redact at source and rescan; no skip.' >&2
    exit 3 ;;
  *)
    rm -f "$REDACT_FILE"
    echo "Redaction scan failed (exit $REDACT_CODE); refusing outside dispatch and downstream persistence." >&2
    exit 1 ;;
esac` : `${scan}\nREDACT_CODE=$?`;

  if (ctx.host === 'codex') return nativeRedaction(ctx, sinkLabel, sink, brief);

  // Brief variant: a compact pointer for repeat sinks, so the full ~40-line
  // procedure ships once per skill, not once per enforcement point.
  if (brief) {
    return `#### Redaction scan — ${sinkLabel} (${sink.noun})

Run the SAME scan-at-sink procedure shown above (resolve \`$REDACT_VIS\` once and
reuse it; when ${sink.noun} changed since the last scan, rewrite the same \`$REDACT_FILE\`
with your file-write tool; \`${bin} --from-file "$REDACT_FILE"
--repo-visibility "$REDACT_VIS" --json\`), now on ${sink.noun}. Apply the same
exit-3/2/0 handling. On exit 3, do NOT ${sink.blockVerb}; HIGH has no skip. Pass the
same \`$REDACT_FILE\` downstream so the bytes scanned are the bytes sent.`;
  }

  return `#### Redaction scan — ${sinkLabel} (${sink.noun})

Scan-at-sink on the EXACT bytes that will be sent: they live in the private file
you wrote with your file-write tool, the scan reads that file, and the SAME file goes
downstream. Never scan a string then re-render it, and never put the text in a shell
command. Substitute the file's printed name for \`<redact-file-name>\`.

\`\`\`bash
${outsideGate ? 'command -v bun >/dev/null 2>&1 || { echo "ERROR: bun unavailable — refusing unscanned outside dispatch." >&2; exit 1; }' : 'command -v bun >/dev/null 2>&1 || echo "redaction scan skipped — bun not on PATH"'}
# Resolve visibility once; cache + reuse. Order: local config (~/.gstack, never
# committed) → gh → glab → unknown(=public-strict).
REDACT_VIS=$(~/.claude/skills/gstack/bin/gstack-config get redact_repo_visibility 2>/dev/null)
[ -z "$REDACT_VIS" ] && REDACT_VIS=$(gh repo view --json visibility -q .visibility 2>/dev/null | tr 'A-Z' 'a-z')
[ -z "$REDACT_VIS" ] && REDACT_VIS=$(glab repo view -F json 2>/dev/null | grep -o '"visibility":"[^"]*"' | head -1 | sed 's/.*:"//;s/"//' | tr 'A-Z' 'a-z')
REDACT_VIS="\${REDACT_VIS:-unknown}"
REDACT_FILE=${FREE_TEXT_DIR.slice(0, -1)}/<redact-file-name>"
[ -s "$REDACT_FILE" ] || { echo "ERROR: $REDACT_FILE is missing or empty — write ${sink.noun} into it first; refusing to send it unscanned." >&2; exit 1; }
${scanAndGate}
\`\`\`

${outsideGate ? 'The shell has already stopped on HIGH, MEDIUM, or scanner failure. On MEDIUM, keep the printed REDACT_FILE pending the decision below: edit/auto-redact and rescan, cancel and remove the file, or resume only after an explicitly permitted acknowledgement. No downstream command runs in that paused shell. Clean scans retain the same scanned file for the approved sink.\n\n' : ''}Branch on \`$REDACT_CODE\`:

1. **Exit 3 (HIGH)** — print findings; do NOT ${sink.blockVerb}; tell the user to
   rotate + redact at source, then re-run. No skip flag for HIGH. Do not persist
   ${sink.noun} anywhere.
2. **Exit 2 (MEDIUM)** — AskUserQuestion per finding (cluster identical ids; PUBLIC
   repos get sterner wording, no batch-acknowledge, no silent-proceed). PII subset
   (\`pii.email\`/\`pii.phone.e164\`/\`pii.ssn\`/\`pii.cc\`) gets **Auto-redact** (re-run
   with \`--auto-redact <ids>\` → use the printed sanitized body) / **Edit** / **Cancel**;
   non-PII MEDIUM gets **Proceed (acknowledged)** / **Edit** / **Cancel** (no auto-redact).
3. **Exit 0 (clean)** — proceed; surface \`WARN\` (tool-fence degrades) + \`LOW\` as a
   one-line FYI (never blocks).

${outsideGate ? 'After the approved sink consumes the file, or when the user cancels, clean up (never before dispatch reads the scanned bytes):\n\n' : ''}\`\`\`bash
rm -f "$REDACT_FILE"
\`\`\`

Guardrail, not airtight enforcement — direct \`gh\`/\`git\` bypass it; it catches accidents.`;
}

function nativeRedaction(ctx: TemplateContext, label: string, sink: SinkSpec, brief: boolean): string {
  const bin = ctx.paths.binDir;
  const blockVerb = label === 'pre-codex' ? 'dispatch to the native reviewer' : sink.blockVerb;
  const lifecycle = `Keep the SAME owned input through the final consumer, with the recorded scan SHA-256.
Only after all authorised consumers finish successfully, invoke
\`bun "${bin}/gstack-private-input" --retire "<trusted allocated path>" --sha256 <recorded-sha256>\`.
This validates ownership and exact bytes, then moves only its own artifact to
recoverable Trash. On failure, changed bytes, or unavailable Trash, report
\`retained_private\`, its trusted allocation path and reason locally; do not erase,
blank, replay or silently accumulate it. Never select unrelated files or symlinks.
Pre/post identity, exact-entry and raw-byte validation is best-effort: a pathname
race can move changed content. A detected race reports retained_private at the
actual recoverable location, not retired success; never restore over a replacement.
This helper does not isolate malicious same-UID processes.`;
  if (brief) return `#### Redaction scan — ${label} (${sink.noun})

Repeat the FULL scan-at-sink procedure above for ${sink.noun}: allocate a fresh
private input, write literal bytes with the file editor (never shell body syntax),
scan fail-closed, and pass the SAME scanned bytes downstream. Reuse verified
visibility; repeat every HIGH/MEDIUM/LOW/WARN branch and operator gate. HIGH has
no skip: do NOT ${blockVerb} or archive/log the raw body. Any edited bytes require
a new scan and any MEDIUM acknowledgment applies only to those exact bytes.

${lifecycle}`;
  return `#### Redaction scan — ${label} (${sink.noun})

Scan-at-sink on the EXACT bytes that will be sent. Allocate a unique private input
with \`bun "${bin}/gstack-private-input" --prepare\` (mode-0700 directory,
mode-0600 input outside the repository). Use the file-edit tool to write the
literal bytes to the exact returned path. A matching private input already made
for semantic review can be reused if unchanged. Never put body text in shell
commands, heredocs, command substitution, environment variables or interpolated
arguments. Text such as shell operators or delimiter lines is untrusted DATA.
Use safely quoted trusted allocation paths only; no shared fixed filenames.

Resolve visibility once: local \`gstack-config get redact_repo_visibility\` first,
then authorised \`gh repo view --json visibility -q .visibility\`, then
\`glab repo view -F json\`, then unknown (= public-strict). Normalize only the
known public/private/internal values; unexpected output means unknown. Preserve
the existing self-email exclusion by reading \`git config user.email\` locally
and supplying it as one safely quoted \`--self-email\` value, never shell syntax.

Require \`command -v bun\` and a readable scanner. Missing tool, command failure,
unexpected exit, malformed JSON or no result BLOCKS the sink; never call that
an unscanned success. Record \`shasum -a 256 "<trusted allocated path>"\` before
and after scanning and immediately before consumption. Require identical hashes.
Invoke the installed local scanner on that file, with verified visibility:
\`bun "${bin}/gstack-redact" --from-file "<trusted allocated path>" --repo-visibility <public|private|internal|unknown> --json\`.
Read the actual exit code and JSON counts/findings together; inconsistent results
fail closed. Never scan a string then re-render it; pass the SAME file or its
unchanged literal bytes through the advertised structured native API.

1. **Exit 3 (HIGH)** — report only masked findings; do NOT ${blockVerb}.
   Tell the user to rotate + redact at source, then re-run. No skip flag for HIGH.
   No raw-body archive, transcript log or dispatch. The already allocated private
   input stays explicitly retained for recoverable handling, not copied elsewhere.
2. **Exit 2 (MEDIUM)** — obtain the operator's answer per finding (cluster identical
   ids; PUBLIC/unknown repos get sterner wording, no batch-acknowledge and no
   silent-proceed). PII subset \`pii.email\` / \`pii.phone.e164\` / \`pii.ssn\` /
   \`pii.cc\`: **Auto-redact** / **Edit** / **Cancel**. Other MEDIUM:
   **Proceed (acknowledged)** / **Edit** / **Cancel**, no auto-redact.
   Use the native required-decision path; lack of optional input is not consent.
   Auto-redact uses the same file with \`--auto-redact <selected-ids>\` only after
   the operator selects it; validate ids against the findings. Capture sanitized
   stdout and raw-diff stderr into separately allocated private inputs, never
   print the raw diff into a transcript. Use the sanitized literal bytes as a new
   private input. Manual edits likewise invalidate the old scan. Re-scan edited
   bytes, repeat HIGH/MEDIUM decisions, and record the new hash before any sink.
3. **Exit 0 (clean)** — proceed only with the same scanned bytes and existing
   authority; surface WARN (tool-fence degrades) + LOW as one-line FYIs, not blocks.

${lifecycle}

Guardrail, not airtight enforcement: this is generated agent guidance, not an
enforced sandbox. Direct sink bypass and actual model compliance remain unproven.`;
}
