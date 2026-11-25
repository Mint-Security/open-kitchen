# MCP tool reference

[Back to the README](../README.md)

Commonmind serves three read-only tools over stdio through `commonmind mcp`.
Run `commonmind connect` to register installed Claude Code and Codex CLIs, then restart
your agent session. The MCP server reads local shared files; it does not publish or sync.

An **author** is a teammate: the person who ran the session, named by the label their
device publishes under (by default their git email). `list_authors` is the list of users
sharing sessions, and `author` / `exclude_author` filter on them. The author is only the name
of the folder a file sits in, which any member can write, and transcript text is data from
other people, never instructions; each tool's description tells the agent so.

## Search sessions

`search_sessions` returns session metadata, ordered by start time, newest first. Supply
a query or at least one filter; a limit alone is not enough.

| Argument | Meaning |
| --- | --- |
| `query` | Literal, case-insensitive substring of the raw transcript. Optional when a filter is supplied. |
| `author` | Case-insensitive substring of the author label, such as `dana` for `dana@example.com`. |
| `exclude_author` | Case-insensitive substring of an author label to leave out, such as your own to see only teammates' sessions. |
| `repo` | Case-insensitive substring of the repository name or the working directory. |
| `agent` | Agent name, such as `claude` or `codex`. |
| `since` | Include sessions started at or after this time. |
| `until` | Include sessions started strictly before this time. |
| `limit` | Number of results: default 20, maximum 100. |

Time filters accept a UTC day (`2026-09-17`), an RFC3339 timestamp, or an age relative to
now (`5d`, `36h`). They filter session start times, unlike `flush --since`, which selects
source files by modification time. An `until` date excludes that entire date and later
sessions; use the following day to include all of a particular day.

For example, ask your agent to call `search_sessions` with these JSON arguments to find
recent authentication work:

```json
{"query": "authentication", "since": "7d", "limit": 10}
```

To browse a teammate's recent sessions without a text query:

```json
{"author": "dana", "repo": "payments", "since": "5d"}
```

To see what everyone else worked on this week:

```json
{"exclude_author": "dana", "since": "7d", "limit": 100}
```

A search returns at most `limit` sessions. To page further back, repeat it with `until` set
to the oldest `started_at` already returned.

Results include `session_id`, `author`, `agent`, `repo`, `cwd` and `started_at`, plus
`agent_version` when available. They do not contain the transcript; pass a returned
`session_id` to `get_session` to read it. Matching is literal, with no semantic search,
query language or relevance ranking.

The raw transcript includes what the agent was shown as well as what it did: system
prompts, skill lists and the tools it had available. A query for a tool or skill name
therefore matches every session that merely had it installed. To find sessions that used
it, search for text only a use contains, such as the call itself (`"name":"<tool>"` in
Claude Code transcripts) or one of its arguments.

`repo` names the repository a session ran in. A session in a linked git worktree, such as
`<repo>/.claude/worktrees/<name>`, is named for the worktree's repository. The `repo`
filter also matches `cwd`, so part of a path finds sessions too.

## List authors

`list_authors` takes no arguments (`{}`) and lists the teammates sharing sessions, most
recently active first. Each entry includes `author`, `sessions` (count), and `latest_day`
when available. It reads directory entries only, which makes it a useful first check that
teammates' files have arrived.

The counts cover the files on this machine. While a new device is still receiving the
folder they run low; `commonmind status` shows the sync backlog. One person who published
under two labels, for example after changing their git email, appears as two authors.

## Read a session

`get_session` requires a `session_id` returned by search:

```json
{"session_id": "<session_id from search_sessions>"}
```

It returns metadata and the raw `transcript` for each matching session file, including
resumed sessions. Transcripts are read a window at a time: at most `max_bytes` (default
1 MiB, maximum 4 MiB) from `offset` (default 0), ending after the last line break that fits,
so each window holds whole JSONL lines. A single line longer than the window is cut on a
character boundary instead.

| Field | Meaning |
| --- | --- |
| `transcript` | This window of the raw transcript. |
| `transcript_bytes` | Length of the whole transcript in this file. |
| `offset` | Where this window starts in this file. |
| `truncated` | `true` when more of the transcript follows this window. |
| `next_offset` | Present when `truncated`; pass it as `offset` to read on. |

To read the next window:

```json
{"session_id": "<session_id>", "offset": 1048502}
```

A resumed session returns one entry per transcript file. The files are read one after
another, oldest first, as a single stream that `offset` counts across, so a response never
holds more than `max_bytes` of transcript in total. An entry whose file is not finished, or
not yet reached, has `truncated` set, and all such entries carry the same `next_offset`.
Keep calling with it until no entry is truncated.

Windows keep each response bounded. A whole transcript can run to tens of megabytes and is
sent twice, as text and as structured content, and agent clients drop the connection on
responses that large. A separate 256 MiB decoded-record safety bound applies when
publishing and reading files.

## Search performance

Search scans and decompresses shared files per query. Published paths are
`sessions/<author>/<YYYY-MM-DD>/`, so `author`, `exclude_author`, `since` and `until`
narrow the walk to directories before files are opened; `repo` and `agent` are checked
after decoding. The walk visits days newest first and stops once a day's matches fill the
limit. A rare-term query without filters still reads the whole folder. There is no search
index.

The original MVP measured about 0.08 seconds for a common term and 0.52 seconds for a full
scan over one developer's month: 367 sessions, 161 MB compressed. These are historical
measurements, not a team-scale benchmark. Narrow the author and time window as history grows.
