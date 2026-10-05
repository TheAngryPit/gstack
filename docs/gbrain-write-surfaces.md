# gbrain write surfaces — what lands where, and how to verify

This doc serves two audiences:

1. **Agents**: when a planning skill renders the compact `## Brain Context
   Load` or `## Save Results to Brain` blocks, those blocks reference this
   doc. Read §Context Load or §Save Template here on-demand when you're
   actually using gbrain. Skip entirely if `gbrain` is not on PATH.
2. **Humans**: after running a planning skill against a real brain, use
   the manual-probe sections to confirm the page actually landed.

## What lands where

| Host + detection state | What renders in the planning-skill SKILL.md |
|---|---|
| Claude + `gstack-config gbrain-refresh` reports `gbrain_local_status: "ok"` | Compressed brain-aware blocks render. Agent reads this doc on-demand when it actually saves. ~250 token overhead per planning skill. |
| Codex + `gstack-config gbrain-refresh --host codex --server NAME` | Explicitly bound context reads and task-authorized saves render into the local Codex skill tree. |
| Any host + gbrain not detected | Blocks suppressed at gen-time. Zero token overhead. Calibration takes still render (separate resolver, host-agnostic). |
| GBrain or Hermes host | Blocks always render regardless of detection — these hosts ship gbrain integration as a first-class concern. |

### Codex: select an existing brain explicitly

Run `gstack-config gbrain-refresh --host codex --server NAME`, where NAME is
the intended enabled local stdio server in the current Codex `config.toml`.
It must invoke GBrain with `serve` and provide explicit `GBRAIN_HOME` and
`GBRAIN_SOURCE`. A machine with several brains never selects one by ordering.
The resolved executable must be named `gbrain`; inherited `env_vars` registrations
and non-host mounted-brain bindings are unsupported and fail before probing.
The brain must explicitly configure the Postgres engine: PGLite is unsupported
because its native stdio server owns the embedded database. Use that owning MCP
surface for PGLite instead of launching a competing CLI. Registrations with tool
allowlists, disabled tools, per-tool approvals or unknown configuration fields
are rejected; a CLI call must not bypass native MCP restrictions.
No server is installed and no brain is created. The command performs a read-only
health probe, then uses the existing `gen-skill-docs` generator to install Codex
enrichment. The selected Codex model is retained (`--model MODEL` is optional).

The local `~/.gstack/gbrain-codex-binding.json` stores the selected name, paths,
source, and a fingerprint. It does not copy database credentials or provider
environment values. Each call revalidates the existing native registration and
brain configuration, then uses that registration's environment and explicit
source. Missing, disabled, or changed bindings fail closed; a deliberate
`--server NAME` refresh accepts a reviewed change. A repeat refresh can omit
`--server` while the existing binding remains unchanged.

Use `gstack-gbrain-detect --host codex` (or add `--is-ok`) to probe that binding.
The explicit host keeps this selection separate from other hosts' defaults.
Codex refresh marks its detection snapshot as Codex-only; it cannot enable
other hosts' enrichment. Its MCP mode label comes from the selected native
registration, not a new MCP transport health check.

The rendered skills use `bun "$GSTACK_BIN/gstack-gbrain-codex"` for enrichment.
Supported reads are `search QUERY`, `get SLUG`, and
`call get_page '{"slug":"SLUG","include_content":true}'`. The caller pins
`source_id` and rejects routing overrides. `put SLUG [--content CONTENT]` also
requires `--authorized-write` and the user's task-scoped authorization. Enabling
enrichment grants no automatic output or entity-stub writing authority. The
save templates below describe other hosts; Codex uses its guarded caller.
After a Codex `put`, allocate a fresh `{"op":"get","slug":"<same slug>"}`
request and compare the returned page body before reporting the artifact as
persisted. A successful subprocess exit proves dispatch only, not durable
writeback.
For task-generated Markdown, write a literal local file with the editing tool,
then use `put SLUG < "/absolute/path/to/result.md"`. Never interpolate Markdown
into a shell argument or unquoted heredoc; stdin preserves backticks, dollar
expansions, quotes and backslashes without shell evaluation. `--content` is only
appropriate for an already shell-safe structured argv call.
Source-qualified page slugs are rejected; colons in search text remain literal.
Calls clear ambient GBrain/database routing overrides, pin the configured host
brain, and run from the selected home so an unrelated project's mount or dotenv
cannot choose a different brain. Explicit native environment values are retained,
including a native `DATABASE_URL` that differs from the home configuration.
Detector probes prepend the selected executable directory to that same native
PATH, retaining configured interpreters and provider helpers.

The refresh writes its detection snapshot, binding, and generated files under
the existing gstack state directory and updates only symlinks belonging to this
installation. Previous render/state/link targets are retained in the printed
recovery directory. No global shell profile, native MCP configuration, GBrain
runtime, provider, authentication, or privacy configuration is changed.
If rollback itself fails, the command reports incomplete restoration and its
recovery directory; it does not claim the previous installation was restored.
Refresh publishes an owner-identified v2 lock atomically and recovers a verified
dead same-host owner, retaining its record. Live or unknown owners are never
stolen. An old anonymous lock requires confirming the old refresh has stopped
and moving that exact lock aside; it cannot safely be inferred stale. Lock
recovery is not a claim of crash-atomic installation across every file swap.

### Source selection

For ordinary GBrain CLI calls, `.gbrain-source` selects the source for reads
and writes from that directory, including `gbrain put`; it does not select
the storage engine configured in `~/.gbrain/config.json`. GBrain resolves an
explicit `--source` first, then `GBRAIN_SOURCE`, then the nearest trusted
`.gbrain-source`, followed by registered path and default-source rules.

Native Codex enrichment follows a separate explicit binding: its guarded caller
pins the selected server's `source_id`, clears ambient routing overrides and
runs from the selected home. It does not infer the source from the project
directory's `.gbrain-source`. If a page lands in an unexpected source, inspect
the effective source selection before treating a successful `put` as proof it
reached the intended corpus.

Trust policy (`personal` vs `shared`, per endpoint hash) gates auto-push
and writeback. Set via `gstack-config set
brain_trust_policy@<endpoint-hash> personal`. Local PGLite installs
auto-default to `personal`; remote-MCP installs prompt during
`/setup-gbrain` step 9.5.

## §Context Load (agent reads this when running a planning skill)

Before starting, search the brain for relevant context:

1. **Extract 2-4 keywords** from the user's request. Pick nouns, error
   names, file paths, technical terms — NOT verbs or adjectives.
   Example: for "the login page is broken after deploy", search for
   `login broken deploy`.
2. **Search**: `gbrain search "<keyword1 keyword2>"`. Returns lines like
   `[slug] Title (score: 0.85) - first line of content...`.
3. **If few results** (under 3): broaden to the single most specific
   keyword and search again. If still few, proceed without brain context.
4. **Read top 3 results**: `gbrain get "<slug>"` for each. Stop
   after 3 — diminishing returns past that.
5. **Use the context** to inform your analysis. Cite specific slugs in
   your output when a brain page changed your thinking.

If `gbrain search` returns any non-zero exit (gbrain not on PATH, network
flake, throttle), treat as transient: proceed without brain context. Do
not retry inline — the user can re-run the skill later.

## §Save Template (agent reads this when actually saving)

After completing the skill, save the output. The compact resolver block
already shows the slug prefix + title + tag for your specific skill (e.g.
`gbrain put "ceo-plans/<feature-slug>" ...`). The full template:

```bash
gbrain put "<slug-prefix>/<feature-slug>" --content "$(cat <<'EOF'
---
title: "<Title>: <feature name>"
tags: [<tag>, <feature-slug>]
---
<skill output in markdown — the actual deliverable, not a summary>
EOF
)"
```

Read the page back from the **same working directory and account** before
reporting it as saved:

```bash
gbrain get "<slug-prefix>/<feature-slug>"
```

Confirm that the returned page contains the intended title and substantive
output. If the read fails or returns another page, report the save as
unverified and retain the output for retry; do not claim a durable result.
The same rule applies to entity stubs.

**Slug guidance**: `<feature-slug>` should be kebab-case, lowercase, and
unique within the prefix. Prefer concrete project/feature names over
abstract labels. Example: `auth-rate-limit` not `security-fix`.

**Title guidance**: the constant prefix (e.g. "CEO Plan", "Eng Review")
is fixed; the suffix is the human-readable name of the feature/topic.

**Tag guidance**: the first tag is the constant `<tag>` from the skill's
metadata (e.g. `ceo-plan`, `eng-review`). The second tag is the
`<feature-slug>` so cross-page traversal works. Add more tags if obvious
relationships exist (e.g. `[ceo-plan, auth-rate-limit, security]`).

### Entity-stub enrichment

After saving the main page, extract person and organization names
mentioned in the output. For each one:

```bash
# Check if a page exists first
gbrain search "<entity name>"

# If no match, create a stub
gbrain put "entities/<entity-slug>" --content "$(cat <<'EOF'
---
title: "<Person or Company Name>"
tags: [entity, person]
---
Stub page. Mentioned in <skill name> output. Replace with real bio when relevant.
EOF
)"
```

**Only extract real names** — actual person names (e.g. "Garry Tan") and
company/organization names (e.g. "Y Combinator"). Skip product names,
feature names, section headings, technical terms (CSS class names,
function names), and file paths. When in doubt, skip.

`tags: [entity, person]` for people, `tags: [entity, organization]` for
companies/teams.

### Error handling

- **Throttle**: exit code 1 with stderr containing `throttle`, `rate
  limit`, `capacity`, or `busy`. Defer the save and move on — the brain
  is busy; the content isn't lost, just not persisted this run.
- **Any other non-zero exit**: treat as transient failure. Do not retry
  inline — the user can re-run the skill or run
  `gstack-config gbrain-refresh` if they suspect gbrain itself is
  misconfigured.
- **`gbrain: command not found`**: gbrain isn't on PATH. The compact
  resolver block told you to skip — you shouldn't reach this code. If
  you somehow did, silently skip and continue.

### Backlinks

If your save output mentions another brain page by name or topic, add a
backlink line at the bottom of the markdown body:

```
Related: [[other-page-slug]], [[another-slug]]
```

gbrain auto-resolves `[[slug]]` syntax into a clickable link in the
rendered page. Add backlinks only when the relationship is concrete
(e.g. "this CEO plan depends on the eng review at
`eng-reviews/auth-rate-limit`"). Don't fabricate connections.

### Completion summary

In your final skill output, note brain utilization in one line:
"Brain: read 3 pages, saved and read back 1 page, enriched 2 entity stubs,
0 throttles." Count a page as saved only after its readback succeeds.
This helps the user see brain coverage growing over time.

## Persistence verification (automated)

The matched-pair "is the data we hope to save actually being saved?"
question is covered by `test/skill-e2e-gbrain-roundtrip-local.test.ts`:
real `gbrain init --pglite` + `gbrain put` + `gbrain get` round-trip
against an isolated temp HOME. Periodic-tier. Skips when
`VOYAGE_API_KEY` is unset or gbrain CLI is missing from PATH.

Run it before opening a PR that touches the resolver:

```bash
EVALS=1 EVALS_TIER=periodic VOYAGE_API_KEY=$VOYAGE_API_KEY \
  bun test test/skill-e2e-gbrain-roundtrip-local.test.ts
```

If you do want to spot-check by hand against your own brain after a
real planning-skill run (debugging a specific page that the agent
should have saved):

```bash
gbrain get "<prefix>/<slug>"           # expect markdown + frontmatter
gbrain search "<slug fragment>"        # expect slug in top results
gbrain sources list                    # confirm gstack-brain-<user> source
gbrain get "entities/<person>"         # expect stub per named person
```

## Remote / Supabase / thin-client-MCP routing

The resolver emits a single CLI shape — `gbrain put "<slug>" --content
"..."` — that works against every engine gbrain supports. The CLI
internally routes to local PGLite, remote Supabase, or a remote MCP
endpoint depending on the user's `~/.gbrain/config.json`. **gstack
doesn't test that routing**: the storage layer is gbrain's contract to
honor, and the same CLI invocation we test against local PGLite is the
one that fires against any other engine.

If you're on Supabase or thin-client MCP and writes aren't landing:

1. `gbrain doctor --fast --json` — engine health check. If anything
   reports `error`, fix that first.
2. `gstack-config get brain_trust_policy@<endpoint-hash>` must be
   `personal` for auto-write. Run `gstack-config endpoint-hash` to get
   the active hash. If `shared`, the agent prompts before writes — if
   you declined, re-run the skill.
3. If trust policy is `personal` and `gbrain doctor` is clean but the
   page still isn't there, file an issue against gbrain — gstack's
   CLI call shape is the same as what T11 (`gbrain-roundtrip-local`)
   exercises.

## What's NOT verified by automation

- **Calibration takes (`takes_add`)**: today these fall back to
  fence-block writes inside a `gbrain put` because
  `BRAIN_CALIBRATION_WRITEBACK` is FALSE pending gbrain v0.42+ shipping
  the `takes_add` MCP op. When the flag flips, re-run the probe in this
  doc against `/office-hours` and confirm `gbrain takes_list` surfaces a
  `kind=bet` entry with the expected weight (0.9 for office-hours, per
  `scripts/brain-cache-spec.ts:151-157`).
- **Per-skill E2E for the other 4 planning skills**: only `/office-hours`
  has fake-CLI E2E coverage (`test/skill-e2e-office-hours-brain-writeback.test.ts`).
  The resolver unit test (`test/resolvers-gbrain-save-results.test.ts`)
  covers wiring for all 5. Per-skill E2E expansion is tracked in TODOS.md.
- **`.gbrain-source` write semantics**: gstack treats the documented
  reads-only contract as load-bearing, but doesn't independently verify
  that gbrain CLI never re-routes writes based on the pin. If you find a
  case where it does, that's a gbrain bug to file upstream.
