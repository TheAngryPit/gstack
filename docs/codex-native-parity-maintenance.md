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
   output for every host, adjacent owner tests and the full free suite. Record
   actual pass/fail/skip and environment gaps separately. Never weaken a gate
   just to accept a new source pin.
5. Commit only reviewed source and generated tracked outputs. When local
   acceptance is limited by platform-specific probes, publish a draft candidate
   after focused parity passes so the unchanged upstream Free Tests CI can run
   on its required platforms. Keep one downstream pull request current and
   label incomplete coverage. Conflicts or failed checks require repair; never
   accept or promote the candidate until all required checks pass.

## Boundaries

Maintaining this branch does not install skills, run setup, register hooks,
change machine configuration, modify memory data or switch providers. Model
profiles come from the operator's native Codex routing. There are no model API
keys or paid evaluation calls in the parity CI job. The upstream paid E2E
entry jobs are restricted to the official repository, so a downstream PR does
not build/publish evaluation images or dispatch paid model probes.

The native hourly task owns source updates and semantic reconciliation. CI
independently checks the branch on every push. A scheduled check is not a
promise of zero delay after an upstream release; report the observed source
version and timestamp, and surface concrete failures.

## Local acceptance

Use a disposable HOME, unset inherited GBRAIN_HOME and model credentials, and
use a canonical temporary directory without symlink ancestors. Do not run the
full runner against the operator's live home. macOS-only containment or observer
gaps must remain explicit; the platform CI supplies the full acceptance gate.

```sh
bun test test/codex-native-parity.test.ts \
  test/codex-native-source-parity.test.ts \
  test/codex-native-complete-output.test.ts \
  test/codex-section-loading.test.ts
bun run gen:skill-docs --host all --out-dir /tmp/gstack-parity-render
bun run test
```

Generated output is inspected in scratch storage, never through live installed
skill links. Main and carved sections are both part of the parity contract.
