# Inactive upstream workflow definitions

These files preserve the reconciled upstream definitions for source comparison.
GitHub Actions only discovers `.github/workflows/`, so nothing here executes.
Do not copy them back during a source refresh. Keep the downstream allowlist
and its regression test intact; an upstream PR runs the original repository CI.

The archived `free-tests.yml` describes upstream coverage. The active workflow
of that name deliberately validates only our downstream adaptations.
