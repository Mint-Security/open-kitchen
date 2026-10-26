# Dividend's tips

Each tip comes from what Claude Code reports, not from a price table of Dividend's own: dollars appear only where Claude Code gives them (its `/cost` total at list price), tokens everywhere else. On a subscription the dollars are not your bill; the plan's limits are what a session uses up.

| Area | Tip | When |
|---|---|---|
| Cache | This message re-cached the conversation | a turn's first request wrote 40k+ tokens to the cache while reading back under a fifth of that, in a conversation that already held 40k+; the tip says why: a break outlasted the cache, the effort level changed, or something near the start of the conversation changed |
| Cache | Switching models re-cached the conversation | the same, on the first turn after a model change |
| Cache | Your next message will re-cache | a break outlasted the cache in a conversation of 40k+ tokens, or a resumed conversation comes back after its cache lapsed |
| Cache | Compact before a break | 10 minutes before an hour-long cache lapses, in a conversation of 80k+ tokens |
| Cache | A longer cache | on API billing, three breaks of 5 to 60 minutes came back to an expired cache and none to a warm one: `"promptCacheTtl": "1h"` would keep it |
| Context | Every message carries | the context passes 120k tokens or 60% of the window, and again past 85% |
| Context | A heavy turn | one turn added 50k+ tokens, and a single tool output explains a good part of it |
| Context | A good moment to compact | a `git commit`, or tests passing, in a conversation of 60k+ tokens |
| Context | Same file read again | the same part of one file read three times |
| Context | Unused MCP servers | after 5 turns, servers never called that add 2k+ tokens each (in the pane only) |
| Context | Repeated instructions | a line of 40+ characters appears in more than one instruction file |
| Context | Instruction files | CLAUDE.md, AGENTS.md, rules and memory files add 10k+ tokens to every request; the tip names where the weight is and what to do about it |
| Limits | Rate limit | the 5-hour or weekly limit is on pace to run out before it resets, or passes 80% |
| Limits | Near the wall | a limit passes 95%: wrap up cleanly before it stops mid-task |
| Limits | A lighter model | three turns in a row of only reading and editing, on Opus |
| Limits | Opus 5.5 for most work | a new conversation (a session's start, or a `/clear`) opens on Mythos or Fable; taken back once a turn answers on another model |
| Limits | Spend alert | off by default; each multiple of the `budgetUsd` setting at list price |

A tip belongs to the session that raised it; the instruction-file tips belong to the project, and the limit tips to the account. *Don't show these* turns that kind of tip off everywhere. A compaction takes back the tips it answers, and news of a turn (a re-cache, a heavy output) leaves the band at your next message.

## How long the prompt cache lasts

The cache lifetime follows Claude Code's own order: `DISABLE_PROMPT_CACHING` (and its per-model variants), `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `promptCacheTtl` in the settings, `ENABLE_PROMPT_CACHING_1H` (and `ENABLE_PROMPT_CACHING_1H_BEDROCK` on Bedrock); with none set, 1 hour on a subscription within its limits and 5 minutes on API billing. Dividend reads the plan off the limits a response reports. This matches Claude Code 2.1.291; a later version may decide it differently.
