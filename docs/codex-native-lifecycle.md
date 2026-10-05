# Codex-native lifecycle bridge

gstack's Codex lifecycle bridge is a small, fail-open command hook at
`hosts/codex/hooks/codex-lifecycle-hook`. The hook writes bounded lifecycle
markers to the existing gstack timeline and emits `{"continue":true}`. It
does not add prompt text or transcript contents to hook output.

The supported events are:

- `SessionStart`
- `UserPromptSubmit`
- `Stop`
- `PreCompact`
- `SessionEnd`

## Reconcile the native registration

`bin/gstack-codex-hooks` is the dedicated, idempotent reconciler. It defaults
to the user Codex layer at `$CODEX_HOME/hooks.json` (or `~/.codex/hooks.json`)
and to this repository's bridge command.

```bash
# Read-only inspection
bin/gstack-codex-hooks status --json

# Read-only prospective diff/status
bin/gstack-codex-hooks plan --json

# Explicitly install the five lifecycle registrations
bin/gstack-codex-hooks install --root "$GSTACK_ROOT" --timeout 3 --json

# Remove only the bridge command; foreign groups and handlers survive
bin/gstack-codex-hooks remove --root "$GSTACK_ROOT" --json
```

The helper preserves unrelated top-level settings, matcher groups, and
handlers. Re-running `install` is a semantic no-op once the exact command and
timeout are present. It writes atomically and refuses malformed event arrays
instead of replacing them. Use `--config`, `--root`, `--command`, and
`--timeout` when setup needs an explicit path or runtime root.

`status` compares the configured command with the exact/equivalent desired
command. A previous gstack-root suffix is used only during reconciliation;
status reports such a path as `stale`, not as installed. The desired executable
is shell-quoted even when its path has no whitespace, so metacharacters in a
repository root remain data rather than shell syntax.

The reconciler does not write a trust hash, trusted flag, managed marker, or
any other trust bypass. After an explicit install, review the exact command
through Codex's native `/hooks` surface and trust it there. The JSON report's
`trust` field is only a reminder of that boundary; it is not native trust
state.

## Capture and import boundaries

Lifecycle markers are local and bounded. The hook never searches for a latest
session, walks the Codex session directory, or substitutes a historical
transcript. Current-session import is off by default and can only run on
`SessionEnd` when the operator sets:

```bash
GSTACK_CODEX_LIFECYCLE_INGEST_CURRENT_SESSION=1
```

The native `transcript_path` must be an absolute regular file. The existing
gstack parser must identify it as a Codex transcript with the same
`session_id` and normalized `cwd` supplied by the hook payload. Partial files
are rejected unless the separate explicit opt-in
`GSTACK_CODEX_LIFECYCLE_ALLOW_PARTIAL=1` is present. No trust hash is
calculated or invented by this bridge.

When the existing `bin/gstack-codex-session-import` importer is invoked, a
native `request_user_input` `function_call` is paired with its matching
`function_call_output`. Each answered native question is logged with its
original question `id`, `source: "codex-import-native"`, native call id, and
exact answer value. The legacy `user_choice` scalar remains bounded for older
readers; the lossless `native_answers` array preserves long free-form and
multi-answer values. Dedup uses a bounded stable hash `tool_use_id`, while
`codex_call_id` and `native_question_id` retain native provenance separately.
Questions marked `isSecret: true` are skipped entirely; their answer is never
sent to the question logger. Other questions in the same native batch remain
importable and the skip is reported categorically.
The importer does not infer a recommendation or convert an answer into an
option merely because it resembles a letter. Older prose Decision Briefs
retain their separate marker/pattern source tags.

The importer refuses transcript input above 8 MiB and reports categorical
`DEGRADED:` reasons for bounded parser failures or question-log spawn,
nonzero, signal, and timeout outcomes. When the opt-in importer exits zero with
`DEGRADED:`, the hook parses its bounded `IMPORTED:` receipt and records a
categorical `session-import-partial`, `session-import-failed`, or
`session-import-degraded` diagnostic while preserving successfully imported
events. Hook subprocesses run in owned process groups and are killed as a
group at the deadline, preventing delayed descendants from writing after a
timeout. The hook itself remains fail-open and records diagnostics locally
without exposing prompt, answer, or transcript content in native hook output.

The bridge has a two-second default internal budget (capped at five seconds),
and the installer gives Codex a three-second command timeout by default.
`GSTACK_CODEX_LIFECYCLE_BUDGET_MS=0` disables the marker/import work while
still returning the fail-open continuation response.

## Operational proof

The focused suites are `test/codex-native-lifecycle.test.ts`,
`test/gstack-codex-session-import.test.ts`, and
`test/gstack-question-log.test.ts`. They cover
idempotent reconciliation, duplicate/interrupted configuration, malformed
configuration, foreign-hook preservation, nullable and non-native transcript
paths, session/workspace mismatch, partial transcripts, fail-open output, and
the bounded/zero-budget path, native question id/source preservation, native
multi-question batches, interrupted native calls, no-turn lifecycle events,
secret-answer redaction, mixed-tool filtering, 8 MiB bounds, semantic partial
and failure receipts, stale-path status, shell metacharacter quoting, deadline
recomputation after slug resolution, process-tree timeout cleanup, and
categorical degraded helper outcomes.
