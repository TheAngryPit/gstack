# Codex native parity maintenance

This downstream branch retains the current official gstack source and adapts its
workflow dispatch to native Codex capabilities. `codex-parity.json` identifies
the exact upstream commit and version covered by the acceptance checks.

## Update contract

1. Resolve `garrytan/gstack` main to an immutable commit and read `VERSION` at
   that commit. Compare this with the manifest, not the downstream Git HEAD.
2. Work in an isolated checkout of `codex/native-parity-latest`. Preserve all
   downstream native adapters; merge the exact official commit. Inspect the
   complete changed-file inventory and actual patches, including dependencies,
   installers, memory, transcript consent, review gates and runtime roots.
3. Reconcile refactored owners instead of retaining dead upstream helpers.
   Preserve rubrics, reviewer independence, user gates and other-host behavior.
   Keep operator model selection and advertised native capabilities authoritative.
   Unavailable reviews remain pending; never count failed execution as clean.
4. Update the manifest only after reconciliation. Run frozen dependencies with
   lifecycle scripts disabled, the four native parity test files, generated
   output for every host, adjacent owner tests and the downstream free checks. Record
   actual pass/fail/skip and environment gaps separately. Never weaken a gate
   just to accept a new source pin.
5. Commit only reviewed source and generated tracked outputs. When local
   acceptance is limited by platform-specific probes, publish a draft candidate
   after focused parity passes so downstream CI can run on hosted Linux.
   Keep one downstream pull request current and label incomplete coverage. Conflicts or failed checks require repair; never
   accept or promote the candidate until all required checks pass.

## Boundaries

Maintaining this branch does not install skills, run setup, register hooks,
change machine configuration, modify memory data or switch providers. Model
profiles come from the operator's native Codex routing. There are no model API
keys or paid evaluation calls in the parity CI job. Upstream paid E2E workflows are archived outside the Actions directory;
a downstream PR does not publish images or dispatch paid model probes.

The twice-daily source monitor checks for upstream updates and performs
semantic reconciliation. It prepares source changes; installation and
activation remain separate operator actions. CI independently checks the
branch on every push. A scheduled check is not a promise of zero delay after
an upstream release; report the observed source version and timestamp, and
surface concrete failures.

## Local acceptance

Use a disposable HOME, unset inherited GBRAIN_HOME and model credentials, and
use a canonical temporary directory without symlink ancestors. Do not run the
full runner against the operator's live home. macOS-only containment or observer
gaps must remain explicit; hosted downstream CI supplies the scoped acceptance gate.

```sh
bun test test/codex-native-parity.test.ts \
  test/codex-native-source-parity.test.ts \
  test/codex-native-complete-output.test.ts \
  test/codex-section-loading.test.ts
bun run gen:skill-docs --host all --out-dir /tmp/gstack-parity-render
```

Generated output is inspected in scratch storage, never through live installed
skill links. Main and carved sections are both part of the parity contract.

## Fork CI ownership

The operator selected downstream-only, free validation on November 8, 2026.
Four workflows are active: Codex native parity, Free Tests, Quality gate and
Workflow Lint. They validate the native adapters, shared rendering and lifecycle
boundaries, generated output, type ratchets, credentials and workflow policy.
They use read-only tokens and hosted Linux runners, without model API calls.

Upstream release automation, image publishing, paid evaluations, recurring
campaigns and platform qualification workflows live in `.github/upstream-workflows/`.
GitHub does not execute that directory. The upstream Free Tests definition is
archived too; the active workflow with that name runs the downstream selection,
not the entire upstream suite. Tests of archived workflow contracts are upstream
fixtures and are not downstream acceptance requirements. An upstream contribution
uses the original repository's CI. This scoped gate does not certify the full
upstream suite, all operating systems or live model behavior.
