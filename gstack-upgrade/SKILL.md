---
name: gstack-upgrade
version: 1.1.0
description: Upgrade GStack from verified fork CI.
triggers:
  - upgrade gstack
  - update gstack version
  - get latest gstack
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# /gstack-upgrade

Upgrade the registered GStack checkout through its origin-specific route. The
trusted fork uses an exact commit accepted by the required CI workflows. Other
origins keep their manual update route. Do not perform source rewrites, upstream
clones, installs, hook registration, or setup migrations in the model.
gstack-session-update owns trusted-fork activation, rollback, and verification.

## Inline upgrade flow

The update checker reports one of:

- UPGRADE_AVAILABLE <old> <new> <sha> — the exact fork commit passed the
  required latest Actions attempts and aggregate jobs.
- MANUAL_UPGRADE_AVAILABLE <old> <new> <target> <repo> — a newer version was
  found on another GitHub origin. This version-only notice has no exact CI
  acceptance and never authorizes trusted-fork activation.
- JUST_UPGRADED <from> <to> — activation and registered-runtime readback
  completed.
- CHECK_FAILED ... — the target or its CI evidence could not be verified.
  Treat update status as unknown; never call it current.

Find the trusted registered source and state directory using the installed
GStack paths:

```bash
# Claude has no runtime-root preamble; other hosts resolve GSTACK_BIN before
# this block through the generated runtime prelude.
if [ "claude" = claude ]; then
  GSTACK_BIN="${GSTACK_BIN:-${GSTACK_ROOT:+$GSTACK_ROOT/bin}}"
  GSTACK_BIN="${GSTACK_BIN:-$HOME/.claude/skills/gstack/bin}"
fi
GSTACK_STATE_ROOT=$("$GSTACK_BIN/gstack-paths" --get GSTACK_STATE_ROOT)
SOURCE_DIR=""
if [ "claude" = copilot ]; then
  SOURCE_DIR="$(cat "$HOME/.copilot/skills/gstack/.source-path" 2>/dev/null || true)"
fi
if [ -z "$SOURCE_DIR" ] && [ -f "$GSTACK_STATE_ROOT/installs.tsv" ]; then
  while IFS=$'\t' read -r _registry_host _registry_scope _registry_project _registry_dest _registry_root _registry_source _registry_version _registry_prefix _registry_render _registry_updated _registry_model _registry_commit; do
    [ "$_registry_host" = "claude" ] && [ "$_registry_source" != "-" ] || continue
    SOURCE_DIR="$_registry_source"
    break
  done < "$GSTACK_STATE_ROOT/installs.tsv"
fi
[ -z "$SOURCE_DIR" ] || [ -d "$SOURCE_DIR/.git" ] || {
  if [ -x "$GSTACK_STATE_ROOT/session-update-recovery/recover" ]; then
    echo "Recovering an interrupted source swap before checking update status."
    "$GSTACK_STATE_ROOT/session-update-recovery/recover" || exit 1
  fi
}
[ -n "$SOURCE_DIR" ] && [ -f "$SOURCE_DIR/bin/gstack-session-update" ] || {
  echo "ERROR: the trusted registered GStack source was not found; no update was attempted." >&2
  exit 1
}
SOURCE_ORIGIN="$(git -C "$SOURCE_DIR" config --get remote.origin.url 2>/dev/null || true)"
SOURCE_ORIGIN="${SOURCE_ORIGIN%/}"
case "$SOURCE_ORIGIN" in
  https://github.com/TheAngryPit/gstack|https://github.com/TheAngryPit/gstack.git|\
  ssh://git@github.com/TheAngryPit/gstack|ssh://git@github.com/TheAngryPit/gstack.git|\
  git@github.com:TheAngryPit/gstack|git@github.com:TheAngryPit/gstack.git)
    UPDATE_LANE=trusted-fork
    ;;
  *) UPDATE_LANE=manual-origin ;;
esac
if [ "$UPDATE_LANE" = trusted-fork ] && [ "claude" != codex ]; then
  echo "DEFERRED: trusted-fork auto-activation is limited to registered Codex runtimes; this host was not changed. Use the host's normal manual setup workflow." >&2
  exit 1
fi
echo "UPDATE_LANE=$UPDATE_LANE"
echo "SOURCE_DIR=$SOURCE_DIR"
echo "GSTACK_STATE_ROOT=$GSTACK_STATE_ROOT"
```

The values printed above are used in the command below. Never infer the
destination from a default path: the installer reads the registered host,
destination, runtime root, prefix and Codex generation model.

### Trusted-fork automatic or approved activation

Check the existing preference:

```bash
AUTO_UPGRADE=$(GSTACK_DIR="$SOURCE_DIR" "$SOURCE_DIR/bin/gstack-config" get auto_upgrade 2>/dev/null || true)
echo "AUTO_UPGRADE=$AUTO_UPGRADE"
```

If AUTO_UPGRADE=true, apply the exact SHA from UPGRADE_AVAILABLE directly.
Otherwise ask whether to upgrade now, enable automatic upgrades, or snooze this
candidate. “Never ask again” disables update checks; it does not authorize an
unverified update.

### Other origins stay manual

For MANUAL_UPGRADE_AVAILABLE, report that the installed origin has a newer
VERSION but does not have the trusted fork's exact-SHA CI proof. Do not use
--apply-candidate or apply the update automatically, even when auto_upgrade is
true. If the operator asks to update, use that host's existing manual GStack
update procedure. Stop if the source is dirty. Do not stash, reset, or discard
local changes. Run the host's normal setup refresh only after its source update
succeeds. For GitHub Copilot CLI, run `./setup --host copilot --refresh-registered`
from the updated source checkout. The ordinary session
updater continues to route other origins to its preserved legacy implementation.

For “Always keep me up to date”, set auto_upgrade to true through the
registered gstack-config, then continue with the approved candidate. For “Not
now”, write a SHA-keyed snooze so a same-version main commit is still detected:

```bash
SNOOZE_FILE="$GSTACK_STATE_ROOT/update-snoozed"
CANDIDATE_SHA="<sha from UPGRADE_AVAILABLE>"
LEVEL=1
SNOOZED_SHA=""
SNOOZED_LEVEL=""
if [ -f "$SNOOZE_FILE" ]; then
  IFS=' ' read -r SNOOZED_SHA SNOOZED_LEVEL _ < "$SNOOZE_FILE" || true
fi
if [ "$SNOOZED_SHA" = "$CANDIDATE_SHA" ]; then
  LEVEL="$SNOOZED_LEVEL"
  case "$LEVEL" in *[!0-9]*|'') LEVEL=0 ;; esac
fi
LEVEL=$((LEVEL + 1))
[ "$LEVEL" -gt 3 ] && LEVEL=3
printf '%s %s %s\n' "$CANDIDATE_SHA" "$LEVEL" "$(date +%s)" > "$SNOOZE_FILE"
```

After the operator approved this exact candidate, run only:

```bash
GSTACK_DIR="$SOURCE_DIR" "$SOURCE_DIR/bin/gstack-session-update" --apply-candidate "<sha from UPGRADE_AVAILABLE>"
```

The command revalidates that candidate's workflow identities, latest attempts,
exact SHA and successful required jobs immediately before activation. It refuses
dirty, staged, untracked, divergent or unregistered state without touching
source files or stashes. Setup refreshes only registered Codex installs and
reuses their saved destination, model and prefix. It does not provision
dependencies, build binaries, register hooks, migrate config, or write memory.

Read the command result. If it reports an update failure or deferral, report
that directly and stop; do not announce success or run fallback Git commands.
On failure after activation began, the updater restores the retained source,
runtime, render and registry snapshots. If it reports a rollback/recovery
failure, preserve the transaction snapshot path in the report for operator
recovery.

### Confirm and show changes

After a successful command, read the source's VERSION, git rev-parse HEAD,
and GSTACK_STATE_ROOT/just-upgraded-from. The installed registry row must still
name the same host destination and Codex generation model, and its source
commit must equal the installed checkout's HEAD. Only then read the source
CHANGELOG.md and summarize the relevant user-facing changes.

If the check is up to date, say so only when the checker returned UP_TO_DATE.
If it returned CHECK_FAILED, explain that status is unknown and leave the
current installation unchanged.

## Standalone usage

When asked to run /gstack-upgrade, force a fresh check:

```bash
GSTACK_DIR="$SOURCE_DIR" "$SOURCE_DIR/bin/gstack-update-check" --force
```

For UPGRADE_AVAILABLE <old> <new> <sha>, follow the trusted-fork flow above.
For MANUAL_UPGRADE_AVAILABLE, use the manual-origin guidance above. For
CHECK_FAILED, report the reason and stop. For UP_TO_DATE, report the installed
version. The local model never authors replacement skill content: accepted
source templates and generated setup outputs remain the fork-maintained native
adaptation.
