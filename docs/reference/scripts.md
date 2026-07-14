# Scripts

- `vp run dev:desktop` — Builds the local server and launches the Electron desktop application.
- `vp run dev` — Starts the web client and local server together.
- `vp run dev:server` — Starts only the local orchestration server.
- `vp run dev:web` — Starts only the Vite renderer development server.
- `vp run start:desktop` — Starts the built desktop application.
- `vp run build:desktop` — Builds the desktop, server, and renderer pipeline.
- `vp check` — Runs formatting and lint checks.
- `vp run typecheck` — Type-checks every workspace package.
- `vp run test` — Runs each package's `test` script.
- `vp test` — Runs the built-in Vite+ test command.
- `vp run test:desktop-smoke` — Runs the packaged desktop smoke test.
- `vp run dist:desktop:artifact` — Builds an unsigned macOS DMG for the host architecture.
- `vp run dist:desktop:dmg` — Alias for the host-architecture macOS DMG build.
- `vp run dist:desktop:dmg:arm64` — Builds an Apple Silicon DMG in `./release`.
- `vp run dist:desktop:dmg:x64` — Builds an Intel Mac DMG in `./release`.

Desktop artifact options include `--build-version`, `--output-dir`, `--skip-build`, `--keep-stage`,
and `--verbose`. Append them to the Vite+ command, for example
`vp run dist:desktop:dmg:arm64 --skip-build --verbose`.

Set `T3CODE_DEV_INSTANCE` to any value to shift the server and renderer development ports together
for parallel worktrees. Use `T3CODE_PORT_OFFSET` when an explicit numeric offset is preferable.
