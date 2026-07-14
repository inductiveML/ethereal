# AGENTS.md

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the
  `test` package script.

## Project Snapshot

Ethereal is a calm, chat-first desktop workspace for using coding agents such as Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term
maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial
   streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long-term maintainability is a core priority. Before adding new functionality, check whether shared
logic should be extracted to a separate module. Duplicate logic across files is a code smell. Do not
avoid changing existing code when a coherent shared design is clearer.

## Package Roles

- `apps/desktop`: Electron desktop shell and native integration.
- `apps/web`: React/Vite renderer. Owns session UX, conversation/event rendering, and client-side
  state. Connects to the local server through WebSocket.
- `apps/server`: local Node.js WebSocket server. Wraps coding-agent harnesses, serves the React app,
  and manages provider sessions.
- `packages/contracts`: shared Effect/Schema schemas and TypeScript contracts. Keep this package
  schema-only; it must not contain runtime logic.
- `packages/shared`: shared runtime utilities consumed by server and client applications. Use
  explicit subpath exports (for example `@t3tools/shared/git`); there is no barrel index.
- `packages/client-runtime`: runtime shared by desktop renderer client code.

## Reference Repositories

- Open-source Codex repo: https://github.com/openai/codex
- Codex Monitor: https://github.com/Dimillian/CodexMonitor

Use these as implementation references for protocol handling, UX flows, and operational safeguards.
