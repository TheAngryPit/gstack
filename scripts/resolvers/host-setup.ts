import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TemplateContext } from './types';

export function generateSpecHostDispatch(ctx: TemplateContext): string {
  if (ctx.host !== 'codex') return `If A and worktree created: spawn \`claude -p\` with the spec piped via stdin:

\`\`\`bash
[ -r "\${ARCHIVE_PATH:?ARCHIVE_PATH is not set: substitute the archived spec path}" ] || { echo "ERROR: cannot read $ARCHIVE_PATH; nothing was spawned." >&2; exit 1; }
cd -- "\${SPAWN_PATH:?SPAWN_PATH is not set: substitute the printed worktree path}" || exit 1
[ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" ] || { echo "ERROR: $SPAWN_PATH is not a git worktree root; nothing was spawned." >&2; exit 1; }
SPAWN_PATH=$(pwd -P)
cat "$ARCHIVE_PATH" | (cd "$SPAWN_PATH" && claude -p 2>&1) &
SPAWN_PID=$!
echo "Spawned: PID $SPAWN_PID in $SPAWN_PATH (branch $SPAWN_BRANCH)"
echo "Follow with: cd $SPAWN_PATH && claude --resume"
\`\`\`

Update archive frontmatter with \`spec_worktree_path: $SPAWN_PATH\` and
\`spec_executed: true\` (atomic re-write).`;
  return `If the worktree was created, dispatch an authorised native Codex worker
using the tools actually advertised in this session. Use a fresh context
(\`fork_turns: "none"\` where the native API supports it), the approved spec,
exact worktree path/branch, bounded file ownership and verification criteria.
Preserve the selected model and effort. Tell the worker other agents may be
editing the repository: preserve their changes and remain in its assigned worktree.
Do not inherit unrelated conversation or invoke Claude. Do not create a new
user-owned task without the user's explicit request.

If native dispatch is unavailable, record \`review_not_run / api_unavailable\`
and \`spec_executed: false\`; retain the approved local spec and report the exact
missing native capability. Never use a recursive CLI, resume/fork, bypass flags,
a different provider, installation, or a new auth wrapper as a fallback.
Do not fall back to execution in the current dirty checkout after worktree
creation fails. Report that failure with \`spec_executed: false\`.

Record the returned native worker ID or running-process handle and worktree path.
Set \`spec_executed: true\` only after dispatch succeeds; this means execution
started, not completed. Use native waiting to follow through, review its evidence,
and separately record completion or failure. Without a return mechanism, report
the work as paused rather than claiming it continues in the background.`;
}

export function generateGBrainHostMcp(ctx: TemplateContext): string {
  if (ctx.host !== 'codex') return readFileSync(resolve(import.meta.dir, '../templates/gbrain-mcp-legacy.md'), 'utf8').trimEnd();
  return `## Step 5a: Register gbrain in native Codex MCP

Inspect the current registration with \`codex mcp get gbrain --json\` and
\`codex mcp add --help\`. Keep the established brain, source and transport.
Do not print secrets from configuration. A lookup error is not proof of absence:
resolve the cause before adding or replacing a registration. If the existing
registration matches, preserve it and proceed to a bounded tool readback.

For an authorised NEW local-stdio registration, resolve the installed absolute
GBrain CLI path and use the already verified home/source binding:

\`\`\`bash
codex mcp add gbrain --env "GBRAIN_HOME=$GBRAIN_HOME" --env "GBRAIN_SOURCE=$GBRAIN_SOURCE" -- "$GBRAIN_BIN" serve
\`\`\`

Validate those variables before executing; never invent a new home/source or
copy another companion's binding. Do not unregister or overwrite an existing
different target without approval for that specific replacement.

If the user explicitly chose an existing HTTP endpoint instead, use native
\`codex mcp add gbrain --url "$MCP_URL" --bearer-token-env-var GBRAIN_MCP_TOKEN\`
only within that authorised remote scope. This names an environment variable,
not its secret value; do not put token values on argv or expose local stdio
remotely. OAuth or new credential use is a separate authority boundary.

Verify registration with \`codex mcp get gbrain --json\` (redact secret fields),
then verify a known authorised page through the actual Codex MCP tool. Restart
or reload the client if its native lifecycle requires it. Configuration readback
is not MCP runtime proof. A CLI page read may unblock task work but cannot prove
the MCP connector repaired. No Claude binary, settings, or hook is required.

---`;
}

export function generateGBrainHostIntro(ctx: TemplateContext): string {
  if (ctx.host === 'codex') return `You are setting up gbrain for native Codex CLI and MCP access. Reuse the
established local binding when present; installation, provider changes and
remote exposure are not implied by a connection repair. Codex registration is
handled in Step 5a without Claude. Keep host access identity distinct from the
downstream model CLI used by GBrain.`;
  return `You are setting up gbrain (https://github.com/garrytan/gbrain), a persistent
knowledge base, on the user's machine so that this coding agent (typically
Claude Code) can call it as both a CLI and an MCP tool.

**Scope honesty:** This skill's MCP registration step (5a) uses
\`claude mcp add\` and targets Claude Code specifically. Other local hosts
(Cursor, Codex CLI, etc.) will still get the gbrain CLI on PATH — they can
register \`gbrain serve\` in their own MCP config manually after setup.

**Audience:** local machines (macOS, Linux, Windows). openclaw/hermes agents typically run in cloud
docker containers with their own gbrain; "sharing" a brain between them and
local Claude Code is only possible through shared Postgres (Supabase).`;
}

export function generateGBrainHostTranscripts(ctx: TemplateContext): string {
  if (ctx.host !== 'codex') return readFileSync(resolve(import.meta.dir, '../templates/gbrain-transcript-legacy.md'), 'utf8').trimEnd();
  return `## Codex transcript and question capture

Keep three independent controls distinct: local question-event capture, GBrain
transcript ingestion, and artifact Git sync. Enabling one does not authorise the
others. Never silently bulk-ingest because the transcript count is small.

The existing memory collector supports native Codex JSONL sessions as well as
other agents' archives; Claude does not need to be installed or running.
Before historical ingestion, explain the actual collector scope and get
authorisation for the files, destination brain/source, downstream model use and
any sync destination. Its \`--sources transcript\` flag selects a content TYPE,
not a Codex host, repository, or GBrain source. It has no current-repo filter.
Do not promise a repo-only import and run a machine-wide collector. Use a
supported bounded path or stop that narrower import until one is available.

Within approved collector scope, \`gstack-memory-ingest.ts --probe\` counts
eligible files without ingesting. Inspect its result before approved execution.
\`--no-write\` is NOT a read-only probe: it still updates ingestion state.
Retain repository deny/read-only policies and secret scanning; never change
trust simply to make ingestion pass. Local GBrain model processing may contact
its configured provider even when artifact Git sync is off.

For ongoing native capture, use the separately installed Codex lifecycle bridge
and verify its hooks are enabled and loaded in the actual Codex host. Follow
its installer status/readback, then test a synthetic question and completion
event before claiming live automation. Importing a recorded Codex session is
retrospective; it does not prove a live hook fired. No Claude settings or hooks
are involved. A skill-start call alone does not automatically ingest transcripts.

Set \`transcript_ingest_mode\` only to the authorised value: \`off\`,
\`incremental\`, or \`bulk\`. \`off\` means never ingest, not incremental.
Historical ingestion, future capture and sync remain independently reportable.
Verify a resulting authorised page through the canonical GBrain path and record
parser proof, hook/runtime proof, ingestion proof and Git push proof separately.
`;
}
