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

On Windows (Git Bash/MSYS) the `gbrain.exe` binstub starts bun in a new
console, so every Claude Code session would open a visible terminal for the
MCP. Register `bun.exe` with gbrain's entry instead, which attaches to Claude
Code's hidden console. Without them, register `gbrain.exe` by its full name,
because Claude Code does not add `.exe` to a stored path.

```bash
GBRAIN_BIN=$(command -v gbrain)
[ -z "$GBRAIN_BIN" ] && GBRAIN_BIN="$HOME/.bun/bin/gbrain"
claude mcp remove gbrain -s user 2>/dev/null || true
claude mcp remove gbrain 2>/dev/null || true
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    BUN_ROOT="${BUN_INSTALL:-$HOME/.bun}"
    GBRAIN_ENTRY="$BUN_ROOT/install/global/node_modules/gbrain/src/cli.ts"
    if [ -f "$BUN_ROOT/bin/bun.exe" ] && [ -f "$GBRAIN_ENTRY" ]; then
      claude mcp add --scope user gbrain -- "$BUN_ROOT/bin/bun.exe" "$GBRAIN_ENTRY" serve
    else
      claude mcp add --scope user gbrain -- "$BUN_ROOT/bin/gbrain.exe" serve
    fi
    ;;
  *)
    claude mcp add --scope user gbrain -- "$GBRAIN_BIN" serve
    ;;
esac
claude mcp list | grep gbrain  # verify: should show "✓ Connected"
```

On a local PGLite brain, `claude mcp list` can show `Failed to connect`
while an open Claude Code session's gbrain holds the database's single-writer
lock. If `mcp__gbrain__*` tools work in that session, the registration is
fine.

### Both paths

If `claude` is not on PATH: emit "MCP registration skipped — this skill is
Claude-Code-targeted; register `gbrain serve` (or your remote MCP URL) in
your agent's MCP config manually." Continue to step 6.

**Heads-up for the user:** an already-open Claude Code session will not
pick up the new MCP tools until restart. Tell them: "Restart any open
Claude Code sessions to see `mcp__gbrain__*` tools — they're loaded at
session start, not mid-session."

---
