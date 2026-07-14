# Phase 2 Claude PTY report

Date: 2026-07-14  
Branch: `ethereal/phase-2-claude-pty`  
Starting commit: `0b388b44c66ceb782c7c5408a65a9e0c78dd99a8`

## Summary

Claude now has exactly one Ethereal runtime: the user's installed, subscription-authenticated
interactive `claude` CLI running beneath `node-pty`. The Claude Agent SDK implementation, tests,
driver, hidden text-generation adapter, package dependency, and transitive lockfile packages were
removed.

The historical `claudeAgent` driver identifier remains intentionally. It now points exclusively to
the PTY driver so upstream settings and durable threads continue to load without a data migration.
The user-facing provider is simply **Claude**, with a **Subscription** badge. The temporary
development-only `claudePty` identity was removed.

Phase 2 also closes the major interactive gaps found during live testing:

- `AskUserQuestion` renders and resolves through Ethereal's native question UI.
- supervised tool calls use Ethereal's native approval cards;
- startup works without relying on a `SessionStart` hook that Claude Code 2.1.209 does not emit for
  injected HTTP settings;
- prompts are pasted and submitted in separate PTY writes;
- response completion tolerates JSONL flush lag;
- resume cannot be completed by a stale `Stop` hook from an older turn;
- interruption completes when Claude returns to its idle prompt; and
- shutdown uses EOF instead of recording a synthetic `/exit` command.

## Baseline

- Phase 1 implementation head: `0b388b44c66ceb782c7c5408a65a9e0c78dd99a8`.
- Node: `v24.5.0` (repository engine: `^24.13.1`; warning only).
- Vite+: `v0.2.2` at the start of Phase 2.
- Claude Code during final live validation: `2.1.209`.
- Claude authentication: `claude.ai`, first-party, Max subscription.
- Phase 1 check, typecheck, tests, desktop build, and desktop smoke test were green before Phase 2.

## Runtime architecture

```text
Native composer
    -> sanitized bracketed paste
    -> separate Return write
    -> interactive Claude PTY

Claude JSONL transcript
    -> bounded byte-offset tailer
    -> semantic events
    -> ProviderRuntimeEvent

Authenticated loopback HTTP hooks
    -> prompt correlation
    -> lifecycle, approval, and AskUserQuestion bridge
    -> existing Ethereal native UI

Same provider-owned PTY
    -> TerminalManager
    -> optional raw xterm escape hatch
```

No assistant content is scraped from the TUI. Screen-reader output is used only for startup,
attention-state detection, and post-interrupt idle-prompt detection.

## Removed

### Claude Agent SDK implementation

- `apps/server/src/provider/Drivers/ClaudeDriver.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`
- `apps/server/src/provider/Services/ClaudeAdapter.ts`
- `apps/server/src/textGeneration/ClaudeTextGeneration.ts`
- `apps/server/src/textGeneration/ClaudeTextGeneration.test.ts`
- SDK-only provider registry, settings, model, UI, and lint-baseline references

### Dependency and lockfile

- Removed `@anthropic-ai/claude-agent-sdk` from `apps/server/package.json`.
- Regenerated `pnpm-lock.yaml`, removing the SDK and its unused transitive graph.
- Verified the SDK package is absent from `apps/server/node_modules` after install.
- Verified built server, web, and desktop output contains no Claude Agent SDK import or label.

The `@anthropic-ai/claude-code` package name remains only in provider update metadata. It names the
interactive CLI's installation package and is not the Agent SDK.

## PTY reliability fixes

### Readiness and prompt transport

- Claude launches with `--ax-screen-reader` and a stable **Ethereal** session name.
- Claude Code 2.1.209 did not emit the injected HTTP `SessionStart` hook in an isolated real PTY
  probe, so the supported screen-reader idle prompt is the live startup signal.
- Startup readiness is debounced for one second while the TUI and plugins settle.
- Login, trust, update, and onboarding markers take precedence over idle-prompt detection.
- Bracketed paste and Return are separate PTY writes; sending them together left prompts sitting in
  the composer without submission.

### Turn correlation and completion

- The blocking `UserPromptSubmit` hook drains resume-time transcript residue before accepting a
  prompt and records its native `prompt_id`.
- `Stop` is accepted only when that ID matches the active Ethereal turn. A `Stop` received before
  acknowledgement or with an older ID is ignored.
- Transcript records timestamped before the current turn are ignored.
- `Stop.last_assistant_message` supplies the final response if the JSONL text has not flushed yet.
- Completion still requires prompt acknowledgement and no unresolved tool results.
- Claude Code does not send `Stop` when the user presses Ctrl+C, so interruption completes when the
  screen-reader idle prompt reappears.
- Graceful session shutdown sends EOF. This avoids the durable local-command record and late hook
  produced by `/exit`, then retains bounded SIGTERM/SIGKILL escalation.

### Subscription and process safety

- The built-in Claude instance removes Anthropic API keys, auth tokens, alternate base URLs, and
  Bedrock/Vertex/Foundry selectors before launch, preventing accidental usage-billed routing.
- Explicit custom instances preserve their configured environment for deliberate router or API CLI
  setups, but still use the same PTY adapter.
- Claude Code 2.1.200 is the minimum supported version because Ethereal requires correlated prompt
  IDs and the interactive `manual` permission mode.

## AskUserQuestion

`AskUserQuestion` is intercepted with a blocking `PreToolUse` hook. Ethereal validates the payload,
emits `user-input.requested`, renders the existing native question card, and returns the answers in
Claude's expected `updatedInput.answers` map.

- Question text is preserved as Claude's answer-map key.
- Missing descriptions fall back to the option label.
- Multi-select responses are de-duplicated and comma-joined.
- Every question requires a non-empty answer.
- Invalid payloads, timeouts, interruption, process exit, and session shutdown fail closed and
  resolve the native request rather than leaving Claude blocked.
- Other `PreToolUse` events are not implicitly approved.

Live result: Claude displayed a native question card with **Alpha** and **Beta**; selecting **Beta**
returned `ASK_USER_ANSWER: Beta` in the assistant response. Provider logs contained both
`user-input.requested` and `user-input.resolved`.

## Automated validation

| Command                                          | Result                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `vp check`                                       | Passed: 0 errors; 9 pre-existing React nested-component warnings                                  |
| `vp run typecheck`                               | Passed across 11 workspaces                                                                       |
| focused Claude protocol/adapter/user-input tests | Passed: 3 files, 36 tests                                                                         |
| `vp test`                                        | Passed outside the restricted sandbox: 423 files passed, 2 skipped; 3,397 tests passed, 7 skipped |
| `vp run test`                                    | Passed: 155 files passed, 2 skipped; 1,285 tests passed, 7 skipped                                |
| `vp run build:desktop`                           | Passed; only existing source-map and chunk-size warnings                                          |
| `vp run --filter @t3tools/desktop smoke-test`    | Passed; desktop readiness log observed                                                            |
| `CI=true vp i`                                   | Passed; lockfile already up to date and SDK package absent                                        |
| `git diff --check`                               | Passed                                                                                            |

The first restricted-sandbox `vp test` attempt failed because loopback binds and the user's GPG
agent were denied. The required unrestricted rerun passed completely. The first non-interactive
`vp i` invocation requested TTY confirmation for a modules-directory purge; rerunning with
`CI=true` passed without changing the lockfile.

## Live desktop smoke testing

The final development app was launched against the authenticated Claude Max account and exercised
through the real Electron UI.

1. Opened the local Ethereal repository and confirmed Claude provider status/model selection.
2. Sent `Reply with exactly: ETHEREAL_CLAUDE_PTY_OK`; the native timeline rendered the exact reply.
3. Triggered `AskUserQuestion`; selected **Beta** in the native card and received the exact selected
   answer back from Claude.
4. Switched to supervised mode and requested a harmless `printf` command. The native command
   approval card appeared, **approve once** reached Claude, and the expected file content was
   written.
5. Opened the provider's raw Claude session in the terminal drawer and confirmed it was the same PTY.
6. Created a normal shell terminal, ran `pwd`, and received the repository path.
7. Split the terminal horizontally, created a second terminal, and ran `stty size`; the `16 45`
   result confirmed split/resize propagation.
8. Opened changed-file and diff views and confirmed current edits rendered.
9. Restarted Ethereal and confirmed project/thread persistence.
10. Resumed the existing native Claude session and received `RESUME_PTY_OK` without duplicated
    semantic history.
11. Started a long response, pressed **Stop**, and confirmed the UI left the working state. The
    provider log recorded `turn.completed` with `state: "interrupted"` and
    `interruptionCount: 1`.
12. Inspected the persisted transcript after shutdown and confirmed no synthetic `/exit` command was
    appended.

The live resume smoke originally exposed a real stale-hook race: a prior `/exit` record delivered a
late `Stop` that completed the new turn. Prompt-ID correlation, timestamp filtering, transcript
draining, and EOF shutdown fixed it. A subsequent live resume and fresh interrupt smoke passed.

## Preserved intentionally

- `node-pty`, the PTY adapter, TerminalManager, xterm, terminal history/input/resize/split support,
  and provider-owned raw terminal registration.
- Claude JSONL discovery, bounded incremental tailing, semantic parsing, usage events, tools, and
  durable resume cursors.
- Provider-neutral runtime events, approvals, native user input, orchestration, projections, and
  WebSocket contracts.
- The `claudeAgent` compatibility identity for existing settings and durable threads.
- Decode-only `claude.sdk.*` raw-source schema literals for already-persisted Phase 1 events. No
  current runtime or test emits them.
- Generic Claude CLI status, model, auth-status, and update metadata.
- Codex and all other provider adapters.
- Git worktrees, checkpoints, diffs, revert support, SSH, browser preview, and MCP.

## Known limitations and risks

- Claude CLI TUI, hook, and JSONL formats are external protocols and may drift. Compatibility is
  live-validated against Claude Code 2.1.209 and fails closed below 2.1.200.
- Startup and post-interrupt readiness depend on the screen-reader idle-prompt format because
  injected `SessionStart` hooks were absent in 2.1.209.
- Default/plan mode changes require restarting the native Claude session.
- Image attachments are materialized as deterministic local path references; binary data is not
  pasted into the TUI.
- Remote Claude PTY over SSH is not implemented.
- Claude PTY intentionally refuses hidden metadata-generation prompts; select another configured
  provider for generated commit messages, PR copy, branch names, and thread titles.
- The local Node version is below the repository's declared engine.
- Nine unrelated React nested-component warnings predate Phase 2.
- CI can validate the fake PTY, real loopback hook bridge, parser, tailer, and desktop harness, but it
  cannot run a subscription-authenticated generative smoke without user credentials.

## Commit list

- `7e137a2e` `feat: implement interactive Claude PTY runtime` — PTY protocol, hooks, transcript
  tailing, semantics, approvals, recovery, and tests.
- `46206cd3` `feat: expose provider-owned PTYs in terminal` — raw provider PTY integration with the
  existing terminal service.
- `1d87d58f` `feat: integrate Claude PTY provider` — provider registration, settings,
  orchestration, and UI integration.
- `e87c2689` `docs: document Claude PTY architecture` — initial architecture and validation notes.
- `85443a12` `refactor: make Claude PTY the sole Claude runtime` — SDK removal, compatibility
  cutover, native AskUserQuestion, and PTY reliability fixes.
- `docs: finalize Claude PTY validation report` — this final evidence report.
- `chore: mark legacy Claude events decode-only` — PTY-aligned runtime fixture plus the narrow
  persisted-event compatibility seam.

## Result

Claude in Ethereal is PTY-only, subscription-authenticated, natively interactive, and fully covered
by automated and live desktop smoke tests. Phase 2 is complete.
