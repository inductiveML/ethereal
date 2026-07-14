# Phase 1 pruning report

Date: 2026-07-14  
Branch: `ethereal/phase-1-prune`  
Upstream: <https://github.com/pingdotgg/t3code>  
Base commit: `c1ec1915fc16f3dc1ec5d47d9a97f6210a574526`

## Summary

Phase 1 converted the broad T3 Code monorepo into a local-first, macOS-first Ethereal desktop
workspace. The remaining product applications are:

- `apps/desktop`
- `apps/web`
- `apps/server`

The Electron -> React -> typed WebSocket -> local orchestration server path remains intact. Codex,
the current Claude SDK integration, other provider adapters, local persistence, approvals,
terminals, Git worktrees, checkpoints, diffs, browser preview, and MCP support were preserved.

## Baseline

### Environment

- Node: `v24.5.0`
- Repository Node engine: `^24.13.1`
- Vite+: `v0.2.2`
- Source repository: `https://github.com/pingdotgg/t3code`
- Base commit: `c1ec1915fc16f3dc1ec5d47d9a97f6210a574526`

The older local Node version produced an engine warning but did not prevent installation,
checking, testing, or building.

### Initial application and package inventory

Applications:

- `apps/desktop`: 129 tracked files
- `apps/web`: 565 tracked files
- `apps/server`: 459 tracked files
- `apps/mobile`: 635 tracked files
- `apps/marketing`: 46 tracked files

Other major product areas:

- `infra/relay`: 72 tracked files
- `.repos`: 3,439 tracked files
- Seven shared packages, including `packages/tailscale`
- Sixteen lockfile workspace importers
- Mobile native modules embedded under `apps/mobile/modules`

### Initial validation

| Command                                            | Result                                                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `git status`                                       | Clean baseline worktree                                                                                                                         |
| `git rev-parse HEAD`                               | `c1ec1915fc16f3dc1ec5d47d9a97f6210a574526`                                                                                                      |
| `node --version`                                   | `v24.5.0`                                                                                                                                       |
| `vp --version`                                     | `v0.2.2`                                                                                                                                        |
| `vp i`                                             | Passed in approximately 35.5 seconds; approximately 1,868 installed package directories                                                         |
| `vp check`                                         | Passed with 0 errors and 9 existing React nested-component warnings                                                                             |
| `vp run -r typecheck`                              | Passed                                                                                                                                          |
| `vp run test`                                      | Passed on retry: 160 files, 2 skipped; 1,399 tests passed, 7 skipped                                                                            |
| `vp run --filter @t3tools/desktop ensure:electron` | Passed                                                                                                                                          |
| `vp run build:desktop`                             | Passed                                                                                                                                          |
| `vp run --filter @t3tools/desktop smoke-test`      | Exited 0, but the inherited harness was later proved capable of ignoring an early nonzero Electron exit; it was not reliable readiness evidence |

The first sandboxed test attempt could not bind a loopback port and failed with `EPERM`. The
first unrestricted retry encountered a transient mock-server `ECONNRESET`; the next retry passed.
These were execution-environment failures, not persistent product failures.

No baseline interactive GUI session was recorded. A full interactive session was completed after
pruning and after correcting the desktop protocol startup path.

### Initial known issues

- The local Node version was below the repository's declared engine.
- `vp check` reported nine pre-existing React nested-component warnings.
- The old desktop smoke command could report success without proving server readiness.
- No persistent baseline build, typecheck, or full-test failure remained.

## Deleted

### Applications

- `apps/mobile`
- `apps/marketing`

Mobile removal included its Expo and React Native application, native Android and iOS projects,
embedded native modules, fixtures, assets, scripts, native analysis tooling, EAS workflows, and
release machinery.

Marketing removal included the Astro application, marketing build and development scripts,
Vercel integration, marketing assets, and marketing-only dependencies.

### Infrastructure

- `infra/relay`
- Hosted Cloudflare and Alchemy relay deployment code
- Relay PostgreSQL and hosted database code
- Hosted relay tracing and public configuration
- Relay deployment scripts, secrets, workflow inputs, URLs, and documentation
- `.github/workflows/deploy-relay.yml`

The local desktop WebSocket server was retained.

### Product authentication

Removed T3 product authentication and T3 Connect surfaces, including:

- Clerk Electron and React integration
- Clerk passkey support
- Clerk preload and IPC behavior
- T3 Connect sign-in and account UI
- Hosted pairing routes and screens
- Relay access tokens and DPoP implementation
- Account-gated local startup
- Cloud environment onboarding
- Relay-backed connection setup
- Product account and mobile-client settings

Local desktop startup now creates and uses a local environment without requiring Clerk or a T3
account. Provider-specific authentication remains separate.

### Remote-access product surfaces

Removed:

- `packages/tailscale`
- Tailscale pairing and lifecycle integration
- T3 remote-access setup UI
- Hosted environment discovery
- Relay-backed device connection UI
- Remote exposure settings and associated contracts
- Tailscale-specific documentation

Generic SSH support was preserved.

### Reference repositories

Removed:

- `.repos`
- `scripts/sync-reference-repos.ts`
- Its tests and root `sync:repos` command
- Vendored-reference CI, configuration, and documentation references

The retained runtime and test suite no longer depend on vendored repositories.

### Platform and release scope

Removed or simplified:

- Windows NSIS packaging
- Windows icon and release assets
- WSL backend packaging and project-picker behavior
- Linux AppImage and AUR release paths
- Windows-specific `node-pty` artifact construction
- Multi-platform release matrices
- Automatic updater services and UI
- Nightly release scheduling
- Previous-release resolution
- Update-manifest generation and merging
- Discord release notification
- Release-only mock infrastructure
- Automatic publishing

The remaining release workflow is a manually dispatched macOS arm64 or x64 DMG build.

### Workflows and tooling

Removed:

- Mobile EAS preview and production workflows
- Mobile-native static analysis CI
- Relay deployment workflow
- Hosted-infrastructure checks
- Clerk preload assertions
- Marketing builds
- Unsupported-platform release jobs
- Stale upstream issue-vouching and PR-size workflows
- Dead mobile, marketing, relay, updater, and reference-repository scripts

CI now performs install, check, typecheck, tests, desktop build, and desktop smoke testing on macOS.

### Dependencies and patches

Removed direct dependency families used only by deleted surfaces, including:

- Expo and React Native application dependencies
- Mobile navigation and native-module dependencies
- Astro and marketing-only dependencies
- Clerk dependencies
- Cloudflare, Alchemy, and relay-only dependencies
- Tailscale package dependencies
- Relay database and deployment dependencies
- Removed platform packaging dependencies

Deleted mobile-only patches included Expo Metro, React Native navigation, gesture handler,
keyboard controller, Nitro modules, screens, and native menu patches.

Four patches remain, all attached to installed dependencies:

- `@effect/vitest`
- `@ff-labs/fff-node`
- `@pierre/diffs`
- `effect`

The lockfile was regenerated. `react-native` survives only as optional peer metadata of the
retained list dependency, and `electron-winstaller` remains transitively reachable through
`electron-builder`; neither is a retained product surface.

### Branding

Low-risk visible branding now uses:

- `Ethereal`
- `A highly ethereal desktop coding workspace.`

This includes the window title, application display name, HTML metadata, About text, packaging
metadata, README, and local development copy.

Historical package namespaces, storage locations, environment variables, schema identifiers,
bundle identifiers, and URL schemes were intentionally not migrated in Phase 1.

## Preserved intentionally

### Claude SDK adapter

The current Claude Agent SDK adapter remains as a working provider and as a behavioral reference
for the planned interactive Claude Code PTY adapter. Phase 1 did not change Claude runtime
semantics.

### Codex adapter

The Codex app-server integration, provider status, models, runtime modes, approvals, activity
rendering, streaming, and durable sessions remain intact.

### Other provider adapters

Cursor, OpenCode, and Grok were retained because they exercise the provider-neutral architecture
and may remain supported.

### Provider-neutral runtime

The following foundations remain:

- `ProviderService`
- `ProviderRuntimeEvent`
- Provider registry and instances
- Orchestration commands and events
- Projections and reactors
- Runtime receipt bus
- Typed WebSocket contracts
- Settings and local persistence
- Provider and model selection
- Runtime modes and plan mode
- Context-window reporting
- Multi-account provider configuration

### Terminal and `node-pty`

The PTY service and `node-pty` remain because terminals are part of the current desktop vertical
slice and will support the future Claude CLI adapter.

Preserved terminal behavior includes:

- PTY input and output
- Terminal session persistence
- Resize
- Splitting
- xterm rendering
- Path and URL handling
- Terminal context attachment
- Terminal-to-composer context

### Git, worktrees, checkpoints, and diffs

Git integration, worktrees, checkpoints, turn diffs, changed-file rendering, and revert support
remain intact.

### SSH

Generic SSH authentication, tunneling, remote command execution, and desktop password prompts
remain. SSH is independent of the deleted Tailscale product path and may be important for future
remote coding-agent runtimes.

The current SSH command and tunnel implementation still invokes the upstream `t3` npm package in
part of its remote bootstrap path. This is documented as a later fork-ownership cleanup candidate
rather than removed in Phase 1.

### Browser preview and MCP

Browser preview, preview annotations, automation contracts, MCP support, file trees, diff
rendering, and project navigation remain because they are useful secondary surfaces and were not
coupled to the deleted hosted product.

### Remaining technical connection code

A small amount of technical pairing/session functionality remains for SSH tunnels and standalone
browser authentication. It is not T3 product-account authentication.

The `relayManaged` field remains only as a read-and-drop migration shim for existing saved
environment data.

## Validation

### Final clean-state validation

The required destructive install check was run from a clean dependency state:

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules
vp i --frozen-lockfile
vp check
vp run typecheck
vp run -r typecheck
vp run test
vp run --filter @t3tools/desktop ensure:electron
vp run build:desktop
vp run --filter @t3tools/desktop smoke-test
```

| Command                                                      | Result                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Clean `vp i --frozen-lockfile`                               | Passed; 812 packages, 7.29 seconds                                                           |
| `vp check`                                                   | Passed across 1,386 formatted files; 0 lint errors and the same 9 known warnings             |
| `vp run typecheck`                                           | Passed across 11 workspaces                                                                  |
| `vp run -r typecheck`                                        | Passed                                                                                       |
| `vp run test`                                                | Passed: 150 files plus 2 skipped; 1,305 tests passed and 7 skipped; 155.48 seconds wall time |
| `vp test apps/desktop/src/electron/ElectronProtocol.test.ts` | Passed, 7/7                                                                                  |
| Desktop release-staging focused tests                        | Passed, 12/12                                                                                |
| Desktop smoke-environment focused test                       | Passed, 1/1                                                                                  |
| `vp run --filter @t3tools/desktop ensure:electron`           | Passed                                                                                       |
| `vp run build:desktop`                                       | Passed in 15.75 seconds                                                                      |
| `vp run --filter @t3tools/desktop smoke-test`                | Passed; server readiness reached in 3.63 seconds                                             |
| `vp run dist:desktop:dmg:arm64 --skip-build --verbose`       | Passed                                                                                       |
| `hdiutil verify` on the generated DMG                        | Passed                                                                                       |
| `git diff --check`                                           | Passed                                                                                       |
| Repository-wide deleted-path and stale-reference searches    | Passed with only documented compatibility or historical references                           |

An earlier final-suite attempt found two issues: a diagnostic assertion still expected the old
visible server name, and one remote-auth CORS test timed out. The branded assertion was corrected.
The CORS test passed alone in 68 milliseconds and then passed as part of the complete final suite;
no reproducible product defect remained.

### Failures found and fixed

#### Development application stuck on the splash screen

The real desktop development application initially remained on its splash screen. Chromium's
content security policy rejected same-scheme Vite module loading because the desktop URL schemes
had not been registered as standard and secure schemes.

Both `t3code` and `t3code-dev` are now registered before Electron app startup with standard,
secure, fetch, CORS, and stream privileges. Focused protocol tests pass, and the real development
application loads.

The internal schemes were retained for storage and compatibility; only the visible product
branding changed.

#### Smoke test did not prove readiness

The inherited desktop smoke script ignored Electron's exit code, so its baseline success could be
a false positive. After cleanup, it also exposed that an empty or inherited `VITE_DEV_SERVER_URL`
made Electron choose development behavior instead of packaged production assets.

The smoke harness now fails on an early nonzero Electron exit, waits for explicit local-server
readiness, removes `VITE_DEV_SERVER_URL` entirely, and sets only smoke-specific logging. A
regression test covers the environment transformation.

#### Release dependency staging was not deterministic

The desktop artifact builder previously risked resolving floating dependency versions during
release staging.

Release staging now derives exact direct versions from the committed lockfile, generates a
standalone frozen staging lockfile while retaining the necessary package and snapshot graph,
preserves relevant patched dependencies, and installs with:

```bash
vp install --prod --frozen-lockfile
```

The arm64 DMG build completed with exact pinned versions and no dependency downloads during
staging.

### Release artifact

A real arm64 artifact was produced and verified:

- Name: `Ethereal-0.0.28-arm64.dmg`
- Size: 215,076,097 bytes (approximately 205 MiB)
- Contained application: `Ethereal.app`
- Executable and packaged native payloads: arm64
- `Info.plist`: Ethereal product name, expected version, retained compatibility bundle identifier,
  and retained protocol schemes
- `hdiutil verify`: passed

The x64 path remains available but was not live-tested during Phase 1.

## Manual testing

The desktop development application was launched with:

```bash
env PATH=/Users/avp/Developer/avp1598/research/ethereal/node_modules/.bin:/Users/avp/.nvm/versions/node/v24.5.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin node scripts/dev-runner.ts dev:desktop
```

The explicit `PATH` was needed because `vp` was not globally available in the launching shell.

Manual checks completed:

1. Launched the Ethereal desktop window.
2. Added the local Ethereal repository as a project.
3. Confirmed provider status loaded.
4. Created a Codex GPT-5.4 thread.
5. Sent `Reply ETHEREAL_SMOKE_OK only`.
6. Confirmed the exact streamed assistant response appeared.
7. Sent a prompt requiring `pwd`.
8. Confirmed the command activity item rendered and completed.
9. Confirmed the path `/Users/avp/Developer/avp1598/research/ethereal`.
10. Opened changed-file and diff views and confirmed the diff pane rendered.
11. Opened the terminal drawer.
12. Created a terminal and ran `pwd`.
13. Confirmed the terminal output.
14. Split the terminal horizontally and confirmed both sessions rendered.
15. Resized the application window through full-screen toggling, exercising the terminal resize
    path.
16. Stopped and restarted the complete desktop development process.
17. Confirmed the project, Codex thread, messages, diff state, split terminals, and terminal buffer
    persisted.
18. Confirmed the Claude provider initialized sufficiently to expose provider status without
    spending model usage.

Observed non-blocking warnings:

- Grok health check failed because the Grok CLI was not installed.
- The existing list-rendering warning remained.
- Chromium logged stale cache-path errors.
- None prevented the tested desktop vertical slice.

## Remaining cleanup candidates

These items are intentionally deferred:

- Replace the SSH remote bootstrap's dependency on the upstream `t3` npm package with a fork-owned
  runner.
- Decide whether the remaining technical pairing/session APIs should be renamed once their SSH and
  browser-auth roles are clearer.
- Remove the `relayManaged` compatibility field after an explicit saved-state migration window.
- Review historical Tailscale and mobile discussion in `.plans/18-server-auth-model.md`.
- Replace remaining inherited T3 artwork and asset filenames in a dedicated branding phase.
- Plan migration behavior before renaming `@t3tools/*`, `T3CODE_*`, application storage paths,
  schema identifiers, bundle identifiers, or URL schemes.
- Live-test the x64 macOS DMG.
- Add signing and notarization when release credentials and policy are available.
- Decide on an Ethereal updater strategy rather than restoring the deleted T3 nightly updater
  machinery.
- Upgrade the development machine to the declared Node engine.
- Address the nine existing React nested-component warnings separately.
- Investigate the non-blocking Chromium cache warnings.
- Phase 2 should implement the interactive Claude Code PTY adapter without removing the current SDK
  adapter until parity is established.

## Repository size and dependency delta

Values are approximate and based on tracked Git data and installed lockfile/package-manager state.

| Metric                        |             Baseline | Phase 1 implementation head |                 Delta |
| ----------------------------- | -------------------: | --------------------------: | --------------------: |
| Tracked files                 |                5,843 |                       1,451 |       -4,392 (-75.2%) |
| Tracked blob bytes            |          183,154,118 |                  35,656,288 | -147,497,830 (-80.5%) |
| Tracked content size          |            174.7 MiB |                    34.0 MiB |            -140.7 MiB |
| Lockfile lines                |               21,528 |                       9,514 |      -12,014 (-55.8%) |
| Lockfile package entries      |                1,997 |                         987 |       -1,010 (-50.6%) |
| Lockfile snapshot entries     |                2,067 |                         988 |       -1,079 (-52.2%) |
| Workspace importers           |                   16 |                          12 |                    -4 |
| Installed `.pnpm` directories |  approximately 1,868 |                         813 |  approximately -56.5% |
| Clean install time            | approximately 35.5 s |                      7.29 s |  approximately -79.5% |

A reliable like-for-like baseline desktop build time was not retained, so no build-time delta is
claimed.

## Commit list

- `6031ace82a2f1f67d702b6ca32096535d3fcabf4` — `docs: record upstream fork base`
- `056998b451994cddb72b1a092681ef1972248c51` — `chore: remove mobile application`
- `837288e486f9886e888a8d3dcab2d059ddd5f77c` — `chore: remove marketing application`
- `83649368d34b850186712cbed5087bd1c4c27534` — `chore: remove hosted relay infrastructure`
- `0d410d41b37047bd742642b27d29ebf3611fa42a` — `refactor: make desktop application local-first`
- `750f18350ac319c1c70ff065cb3573db70ea28b1` — `chore: remove T3 remote access services`
- `3e7e69c8c341bdd33b4ba1ee3ad8842a25809bec` — `chore: remove reference repository tooling`
- `c850215ce2da4843473f63bdce56b13a1dc70137` — `build: make desktop packaging macOS-first`
- `9e3c907f0f22e6bf8450c003e3161f97d98b7fe4` — `chore: prune workspace dependencies`
- `4c0461bf0bfa8c99bba7e6cf1e24200fed74558e` — `chore: remove remaining WSL project picker code`
- `65032242c79d689accea4a6b087dc163fc1d1ebe` — `chore: brand desktop as Ethereal`
- `4a5944737e6c3b9f9d12a62b65b672a4d71490c0` — `chore: remove stale upstream references`
- `23207867a9ad5fabd84fd3badefd4a5105de142a` — `fix: run desktop smoke in production mode`
- `7c1d8ddf6a7abdd68852a544a3e8d8b50fa74259` — `test: update branded SSH launch assertion`
- Final documentation commit: add this report after final validation.

No commit was pushed, and no pull request or remote setting was created or modified.

## Recommended next phase

Phase 2: interactive Claude Code PTY adapter using subscription-authenticated CLI sessions.
