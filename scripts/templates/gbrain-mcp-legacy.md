## Step 5a: Register gbrain as Claude Code MCP

Only if `which claude` resolves. Ask: "Give Claude Code a typed tool surface
for gbrain? (recommended yes)"

The registration form depends on the path picked in Step 2:

### Path 4 (Remote MCP — HTTP transport with bearer)

Tear down any prior registration (could be local-stdio from an old setup,
or stale remote-http with a rotated token), then register with HTTP +
bearer at user scope:

```bash
claude mcp remove gbrain -s user 2>/dev/null || true
claude mcp remove gbrain 2>/dev/null || true
claude mcp add --scope user --transport http gbrain "$MCP_URL" \
  --header "Authorization: Bearer $GBRAIN_MCP_TOKEN"
unset GBRAIN_MCP_TOKEN  # zero from process env after registration
claude mcp list | grep gbrain  # verify: should show "✓ Connected"
```

**Token-storage note:** `claude mcp add --header "Authorization: Bearer ..."`
puts the bearer on argv during process startup, briefly visible to `ps` for
~10ms. The token's resting state is `~/.claude.json` (mode 0600 — Claude
Code's own credential surface for every MCP server). This trade-off is
documented in `setup-gbrain/memory.md`. If a future Claude Code release adds
a stdin or env-var input form for headers, switch to that.

### Paths 1, 2a, 2b, 3 (Local stdio)

Register at **user scope** with an **absolute path** to the gbrain
binary. User scope makes the MCP available in every Claude Code session on
this machine, not just the current workspace. Absolute path avoids PATH
resolution issues when Claude Code spawns `gbrain serve` as a subprocess.

```bash
GBRAIN_BIN=$(command -v gbrain)
[ -z "$GBRAIN_BIN" ] && GBRAIN_BIN="$HOME/.bun/bin/gbrain"
claude mcp remove gbrain -s user 2>/dev/null || true
claude mcp remove gbrain 2>/dev/null || true
claude mcp add --scope user gbrain -- "$GBRAIN_BIN" serve
claude mcp list | grep gbrain  # verify: should show "✓ Connected"
```

### Both paths

If `claude` is not on PATH: emit "MCP registration skipped — this skill is
Claude-Code-targeted; register `gbrain serve` (or your remote MCP URL) in
your agent's MCP config manually." Continue to step 6.

**Heads-up for the user:** an already-open Claude Code session will not
pick up the new MCP tools until restart. Tell them: "Restart any open
Claude Code sessions to see `mcp__gbrain__*` tools — they're loaded at
session start, not mid-session."

---
