# Interactive Claude Code PTY architecture

## Purpose

Ethereal's Claude PTY driver runs the installed interactive `claude` command beneath the existing
`node-pty` abstraction. This preserves the user's normal Claude Code login and subscription while
keeping Ethereal's primary experience native, semantic, and chat-first.

The retained Claude SDK driver remains separate. The built-in PTY instance is subscription-safe:
it removes Anthropic API credentials and third-party routing variables before launching Claude.
Explicitly configured custom PTY instances preserve their environment because those instances may
intentionally use a router or API-backed provider.

The design was informed by the
[community PTY proof of concept](https://github.com/gigq/t3code/blob/cbe242c095c3bdfc4c2861f89c08f06c88f42069/apps/server/src/provider/Layers/ClaudePtyAdapter.ts)
and the official Claude Code documentation for
[hooks](https://code.claude.com/docs/en/hooks),
[hook responses](https://code.claude.com/docs/en/hooks-guide), and
[permissions](https://code.claude.com/docs/en/permissions).

## Three channels, one provider adapter

```text
Native composer
    -> bracketed paste -> interactive Claude PTY

Claude JSONL transcript
    -> incremental byte tailer -> semantic parser
    -> ProviderRuntimeEvent -> normal orchestration ingestion

Claude HTTP hooks
    -> authenticated loopback endpoint -> lifecycle and approval bridge
    -> ProviderRuntimeEvent -> existing native approval UI
```

No Claude-specific WebSocket API exists. `ClaudePtyAdapter` implements the existing provider adapter
contract and emits the same canonical event family used by other runtimes.

## PTY control channel

The adapter spawns the configured executable and arguments as separate process fields. New sessions
use a generated UUID with `--session-id`; resumed sessions use the stored native ID with `--resume`.
The selected model, effort, runtime mode, plan mode, effective working directory, effective HOME,
and private hook settings are applied before spawn.

User prompts are sent in one bracketed-paste write. ESC and unsafe control characters are removed or
replaced before the paste delimiters are added, so prompt content cannot terminate bracketed-paste
mode early. Multiline text, Unicode, tabs, and code fences remain intact.

The internal readiness state machine is:

```text
starting
  -> needs-attention
  -> ready
  -> working
  -> waiting-for-permission
  -> interrupted
  -> failed
  -> closed
```

`SessionStart` is the authoritative ready signal. Bounded PTY output is retained only for attention
detection; it is never scraped for assistant text. If readiness times out, the process is preserved,
the session becomes an attention state, native composer sends are blocked, and the raw terminal can
be opened. Ethereal never auto-answers an unknown TUI dialog.

Interrupt writes Ctrl+C. Stop first writes `/exit`, then escalates to SIGTERM and SIGKILL after
bounded grace periods. One next turn may be queued while Claude is working; a second queued turn is
rejected. Mid-session default/plan changes are rejected with a restart instruction instead of
driving fragile interactive menus.

## Transcript semantic channel

The primary semantic source is the Claude JSONL transcript. A hook-reported transcript is accepted
only when its resolved path is below the selected instance's `<HOME>/.claude/projects` directory and
its filename matches that native session ID.

For recovery, transcript discovery first checks the expected cwd-derived project path. Its fallback
checks one session filename in at most 256 immediate project directories and chooses the newest
match. It never recursively scans the user's home.

The tailer:

- tracks byte offsets and incomplete trailing bytes;
- reads at most 1 MiB per native read;
- drains bounded chunks while yielding between them;
- uses a filesystem watcher as an acceleration signal and a 75 ms polling fallback;
- coalesces concurrent watcher notifications;
- detects truncation and inode replacement;
- bounds an incomplete JSONL record to 4 MiB;
- remembers a durable offset before any incomplete trailing line;
- deduplicates semantic records across file replacement within a live session.

On resume, the adapter restores the saved offset. For legacy cursors without an offset it starts at
the current end of the existing transcript before accepting a new prompt, because canonical history
is already durable in Ethereal.

The parser recognizes assistant text, prompt acknowledgements, stop reasons, token usage, tool use,
tool results, and tool failures. Tool results are bounded before projection. Assistant text is emitted
in bounded semantic chunks rather than character events.

| Claude record             | Canonical output                                  |
| ------------------------- | ------------------------------------------------- |
| assistant text            | `item.started`, `content.delta`, `item.completed` |
| Bash / shell tool         | `command_execution` item                          |
| Edit / Write / patch tool | `file_change` item                                |
| web tool                  | `web_search` item                                 |
| MCP tool                  | `mcp_tool_call` item                              |
| Agent / subagent tool     | `collab_agent_tool_call` item                     |
| unknown tool              | `dynamic_tool_call` item                          |
| tool result               | correlated `item.completed`                       |
| token usage               | `thread.token-usage.updated`                      |

Turn completion prefers the explicit `Stop` hook, while transcript `stop_reason` is a durable
secondary signal. A turn is not completed until its submitted prompt is acknowledged and all known
tools have results. No-output and hard-turn timers surface warnings and recoverable failures.

## Hook and approval channel

Each live provider session owns a separate HTTP server bound to `127.0.0.1` on an ephemeral port and
a separate random bearer secret. Claude receives the secret only through a named environment
variable referenced from injected hook settings. The server accepts only POST, enforces a 1 MiB body
limit, compares the token in constant time, and rejects a payload for any other native session ID.

`PermissionRequest` is a blocking hook:

```text
Claude PermissionRequest
    -> request.opened
    -> existing Ethereal approval card
    -> accept / acceptForSession / decline / cancel
    -> authenticated HTTP hook response
    -> request.resolved
```

Approval-required mode uses Claude's `manual` permission mode. Auto-accept-edits uses the precise
`acceptEdits` mode. Full access is the only mode that passes `bypassPermissions` and
`--dangerously-skip-permissions`. Unknown requests are never allowed automatically. Approval timeout,
session stop, and process exit all resolve pending requests as cancellation. Ethereal never sends
`y` or `n` to guess at a permission screen.

## Raw terminal escape hatch

The adapter registers the exact same provider-owned PTY with `TerminalManager` as
`claude-pty-raw`. Terminal output fans out through the existing terminal event stream; xterm input
and resize operate on the provider process. The Chat titlebar exposes **Open raw Claude session**
when that terminal exists. Closing the terminal view does not kill the provider-owned process.

This surface is for login, trust, onboarding, updates, and unsupported dialogs. It is not a second
Claude process and is not the normal assistant timeline.

## Resume and instance isolation

The opaque versioned cursor contains:

- native Claude session ID;
- provider instance ID;
- effective HOME identity;
- resolved transcript path and durable byte offset when known;
- completed turn count.

It contains no auth token or hook secret. A cursor from another provider instance or HOME is rejected.
Continuation identities already key Claude instances by resolved HOME, so accounts, authentication,
transcripts, and native sessions cannot silently cross instances.

## Compatibility

The compatibility decision is centralized in `ClaudePtyCapabilities`, derived only from
`claude --version` and `claude --help`. Authentication uses the non-generative
`claude auth status` command. No health probe sends a prompt.

| Claude Code     | Arguments checked                                                  | Hooks               | Approval strategy            | Transcript                       |
| --------------- | ------------------------------------------------------------------ | ------------------- | ---------------------------- | -------------------------------- |
| 2.1.208 (local) | session ID, resume, name, model, effort, settings, permission mode | loopback HTTP hooks | blocking `PermissionRequest` | local JSONL under effective HOME |

Versions without interactive sessions, resume, settings injection, required launch arguments, or
HTTP PermissionRequest hooks are reported as unsupported. They are not silently downgraded to an
unsupervised PTY flow.

## Security and privacy boundaries

- The built-in subscription instance strips API keys, auth tokens, alternate base URLs, and
  Bedrock/Vertex/Foundry selectors.
- Custom instances preserve explicitly configured environments.
- Hook servers are loopback-only, per-session, authenticated, bounded, and closed with the session.
- Prompts are never interpolated through a shell.
- Hook transcript paths are constrained to the selected HOME and native session ID.
- Canonical transcript diagnostics contain record metadata, not full raw transcript records.
- PTY output is bounded and is not written into the semantic timeline.
- Token usage is reported when present; subscription cost remains unknown and is never invented.

## Known limitations

- The end-to-end subscription-backed manual smoke procedure has not been run because it requires
  explicit authorization to consume Claude usage.
- Structured Claude `AskUserQuestion` responses are not bridged in this phase.
- Plan/default mode changes require a session restart.
- Image attachments are materialized as deterministic local path references; binary data is not
  pasted into the TUI.
- The PTY runtime is local-only. Remote Claude over SSH is not implemented.
- Compatibility is validated against Claude Code 2.1.208; future transcript or hook changes may
  require a compatibility update.
