# Ethereal

> A highly ethereal desktop coding workspace.

Ethereal is a calm, chat-first desktop workspace for working with coding agents. It combines an
Electron shell, a React client, and a local orchestration server while using provider CLIs and
authentication already installed on the user's machine.

Phase 1 preserves the core desktop application and removes the upstream marketing site, mobile app,
hosted relay, and hosted web deployment infrastructure.

## Supported providers

Install and authenticate at least one supported provider before starting Ethereal:

- Codex: install the [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`.
- Cursor: install the [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`.
- OpenCode: install [OpenCode](https://opencode.ai) and authenticate it.

## Development

Install [Vite+](https://viteplus.dev/guide/), then install dependencies and launch the desktop app:

```bash
vp install
vp run dev:desktop
```

The required quality gates are:

```bash
vp check
vp run typecheck
```

Run the workspace test package scripts with `vp run test`, or use `vp test` for the built-in Vite+
test command.

## Workspace

- `apps/desktop`: Electron shell and desktop integration.
- `apps/web`: React/Vite renderer used by the desktop shell.
- `apps/server`: local Node.js orchestration server and provider adapters.
- `packages/contracts`: typed schemas and WebSocket contracts.
- `packages/client-runtime`: shared client-side runtime.
- `packages/shared`: shared runtime utilities.

See [the documentation index](./docs/README.md) for architecture, provider, and development notes.
