# Phase 2 Claude PTY report

Date: 2026-07-14  
Branch: `ethereal/phase-2-claude-pty`  
Starting commit: `0b388b44c66ceb782c7c5408a65a9e0c78dd99a8`

## Summary

Phase 2 adds an opt-in, first-class `claudePty` provider that runs the real interactive `claude`
command under Ethereal's existing PTY service. Prompts travel through bracketed paste; assistant
text and tool activity come from Claude JSONL; lifecycle and blocking permissions use authenticated
loopback HTTP hooks; and the same provider PTY can be opened in the existing xterm terminal.

The Claude SDK provider remains available and remains the default. Claude PTY is disabled by
default until the end-to-end subscription-backed manual smoke procedure is explicitly authorized
and completed.

## Baseline

- Phase 1 was complete and green at `0b388b44c66ceb782c7c5408a65a9e0c78dd99a8`.
- Node: `v24.5.0` (repository engine: `^24.13.1`; warning only).
- Vite+: `v0.2.2`.
- Claude Code: `2.1.208` at `/Users/avp/.local/bin/claude`.
- `vp i --frozen-lockfile`: passed.
- `vp check`: passed with the same nine pre-existing React nested-component warnings.
- recursive typecheck: passed across 11 workspaces.
- tests: passed, 150 files plus 2 skipped; 1,305 passed and 7 skipped.
- desktop build: passed.
- desktop smoke test: passed.

The initial sandboxed `claude auth status` probe reported logged out because the execution sandbox
could not access the user's normal authentication context. The user separately supplied an official
status result showing `claude.ai` authentication and a Max subscription. No generation was invoked.

## Reference analysis

The implementation studied the
[gigq/t3code PTY adapter at the requested commit](https://github.com/gigq/t3code/blob/cbe242c095c3bdfc4c2861f89c08f06c88f42069/apps/server/src/provider/Layers/ClaudePtyAdapter.ts).
Ethereal reused its useful ideas—interactive PTY launch, native session IDs, bracketed paste, JSONL
semantics—but replaced line-count polling, default-HOME assumptions, broad transcript scanning, and
idle-only completion with byte offsets, effective-HOME isolation, bounded discovery, lifecycle hooks,
prompt acknowledgement, and tool-aware completion.

Official Claude Code hook and permission documentation was used for the HTTP hook settings and
blocking PermissionRequest response shape.

## Implementation

### Added

- `ClaudePtyDriver.ts`: provider registration, status, maintenance, terminal, attachment, and
  provider-instance integration.
- `ClaudePtyAdapter.ts`: PTY lifecycle, turn queue, prompt transport, canonical events, approvals,
  recovery, resume, timeouts, and raw terminal registration.
- `ClaudePtyProtocol.ts`: compatibility, arguments, safe environment, prompt encoding, readiness,
  incremental JSONL framing, and semantic parsing.
- `ClaudeHookServer.ts`: per-session loopback HTTP bridge.
- `ClaudeTranscriptResolver.ts`: effective-HOME path resolution and bounded fallback.
- `ClaudeTranscriptTailer.ts`: incremental byte tailer with watcher acceleration and polling.
- Focused unit and fake-integration test files for every module above.

### Changed

- Registered `claudePty` in built-in drivers, settings, model defaults, text-generation routing,
  provider labels, icons, context-window display, and session presentation.
- Kept the SDK implementation under the clear `Claude SDK` / `Legacy / API-backed` label.
- Extended the provider session start contract with initial interaction mode.
- Added Claude PTY raw diagnostic sources to canonical runtime contracts.
- Extended `TerminalManager` so a provider-owned PTY can use the existing output, input, history,
  resize, attach, and xterm surfaces without transferring process ownership.
- Added an **Open raw Claude session** titlebar action when the same provider PTY is available.

## Runtime behavior

- Transcript polling fallback: 75 ms; filesystem notifications accelerate it.
- Transcript native read size: at most 1 MiB; bounded drain yields between chunks.
- Startup readiness timeout: 15 seconds, after which the process is preserved as needs-attention.
- Prompt no-output warning: 30 seconds.
- Hard turn timeout: 20 minutes.
- Approval timeout: 2 minutes, fail-closed.
- Graceful stop: `/exit`, then 1.5 second grace, SIGTERM, then bounded SIGKILL fallback.
- Queue: one next turn while working.
- Completion: hook/transcript stop plus prompt acknowledgement and zero tools in flight.
- Subscription cost: unknown by design; no cost is synthesized.

Actual startup, prompt acknowledgement, and response latency were not measured because a generative
manual smoke was not authorized.

## Gates

| Gate                      | Status | Evidence                                                                                                                                                                                                                         |
| ------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: PTY transport          | PASS   | Fake adapter asserts interactive spawn and bracketed input; interrupt is Ctrl+C; provider-owned terminal tests assert output fan-out, input, resize, detach, and no provider-process kill; graceful/forced close is implemented. |
| B: Semantic transcript    | PASS   | Parser/tailer tests cover partial UTF-8 JSONL, multiple records, replacement, bounded large reads, deduplication, assistant text, tools, results, failures, MCP, and subagents without terminal scraping.                        |
| C: Turn correctness       | PASS   | Fake integration covers text/tool completion, prompt acknowledgement, unresolved tools, duplicate records, one-turn queue, interruption, no-output warning, hard timeout, and process-exit failure.                              |
| D: Supervised permissions | PASS   | Real loopback dispatch and fake Claude integration cover token/session rejection, allow once, allow for session, deny, timeout/cancel, duplicate decisions, and no PTY `y`/`n` fallback.                                         |
| E: Resume                 | PASS   | Resume tests assert the native session ID, `--resume`, provider/HOME cursor identity, durable byte offset, and no duplicate semantic replay.                                                                                     |
| F: Raw escape hatch       | PASS   | The same fake provider PTY is registered with TerminalManager; xterm input/output/resize and detach-without-kill are tested; the UI action opens `claude-pty-raw`.                                                               |
| G: No idle usage          | PASS   | Status uses only `--version`, `--help`, and `auth status`; the adapter never spawns a background prompt and hidden text-generation calls explicitly fail.                                                                        |

These are automated gates. The subscription-backed end-to-end manual smoke remains **NOT TESTED**,
so Claude PTY was not promoted to the default provider.

## Automated validation

Focused Claude PTY results from the final clean checkout state:

- Eight focused files passed with 126 tests.
- The hook bridge's real loopback test passed outside the restricted sandbox.
- The full repository suite passed 156 files with 2 skipped and 1,347 tests with 7 skipped.
- `vp run typecheck` and `vp run -r typecheck` both passed across 11 workspaces.
- `vp check` passed with 0 errors and the same 9 baseline warnings.

## Manual testing

- `claude --version`: passed, `2.1.208`.
- `claude --help`: passed; required interactive arguments are present.
- `claude auth status`: user-reported `claude.ai` login with Max subscription; sandbox probe could
  not observe that authentication context.
- Generative desktop smoke: **NOT TESTED**. The task explicitly prohibits subscription usage unless
  the user initiates that test; no Claude prompt was sent.
- GUI raw terminal and native timeline smoke: **NOT TESTED** for the same reason.

### Opt-in live smoke procedure

This procedure is intentionally not automated. Run it only after the user explicitly authorizes
Claude subscription usage:

1. Confirm `claude --version` and `claude auth status` in the same environment used to launch
   Ethereal.
2. Enable Claude PTY, open a local project, create a thread, and select **Claude PTY**.
3. Send `Reply with exactly: ethereal-ready`; confirm the exact native-timeline response and that
   **Open raw Claude session** shows the same session.
4. Ask Claude to read one harmless repository file; confirm a semantic tool card and result.
5. Ask for one tiny reversible edit; confirm the file-change item and diff.
6. In approval-required mode, request a harmless command, deny it, request it again, then allow it;
   confirm both decisions reach Claude.
7. Interrupt a running turn and confirm the canonical outcome is interrupted.
8. Restart Ethereal, resume the same thread, confirm prior content is not duplicated, and send one
   successful continuation turn.
9. Trigger or simulate a login/trust/attention state, resolve it through the raw terminal, and
   return to the native timeline.
10. Revert the test edit and confirm no test-only change remains.

## Existing Claude SDK adapter

The SDK adapter remains available, enabled by default, and labeled `Claude SDK` with a
`Legacy / API-backed` badge. The new PTY provider is present but disabled by default. This is a
deliberate non-cutover because the automated gates pass but the required live subscription-backed
manual workflow has not been run.

## Known limitations and risks

- Live Claude-to-Ethereal hook behavior has not been exercised against the authenticated account.
- Structured `AskUserQuestion` is not bridged.
- Default/plan mode changes require restarting the native Claude session.
- Attachments are passed as deterministic file references; binary image data is not pasted.
- Remote Claude PTY over SSH is not implemented.
- Compatibility is currently anchored to Claude Code 2.1.208 and the documented HTTP hook protocol.
- The local Node version remains below the declared engine.
- Nine unrelated React nested-component lint warnings predate Phase 2.

## Commit list

- `7e137a2e` `feat: implement interactive Claude PTY runtime` — protocol, hooks, transcript
  discovery/tailing, semantic parsing, lifecycle, approvals, recovery, and fake integration.
- `46206cd3` `feat: expose provider-owned PTYs in terminal` — raw provider PTY ownership and terminal
  behavior.
- `1d87d58f` `feat: integrate Claude PTY provider` — driver, settings, orchestration, UI, and SDK
  legacy label.
- `docs: document Claude PTY architecture` — architecture and Phase 2 evidence.

## Final clean validation

- `rm -rf node_modules apps/*/node_modules packages/*/node_modules`: passed.
- Bootstrap `pnpm install --frozen-lockfile`: passed; 812 packages restored from the local store in
  8.16 seconds with no downloads. This was required only because `vp` is a project dependency and
  therefore absent immediately after deleting root `node_modules`.
- `vp i`: passed, already up to date, 0.32 seconds.
- `vp check`: passed; 0 errors and 9 pre-existing React warnings.
- `vp run typecheck`: passed across 11 workspaces.
- `vp run -r typecheck`: passed across 11 workspaces.
- Focused Claude PTY command: passed, 8 files and 126 tests in 1.50 seconds.
- `vp run test`: passed, 156 files plus 2 skipped; 1,347 tests plus 7 skipped in 144.80 seconds.
- `vp run build:desktop`: passed in 15.42 seconds. Vite reported only existing source-map and large
  chunk warnings.
- `vp run --filter @t3tools/desktop smoke-test`: first attempt failed because the restricted sandbox
  blocked macOS LaunchServices registration (`lsregister`, error `-10822`); the required rerun with
  normal macOS application-launch permission passed after observing the desktop readiness log.

The clean install emitted the known engine warning because the machine has Node 24.5.0 while the
repository declares Node `^24.13.1`. It did not affect any validation result.
