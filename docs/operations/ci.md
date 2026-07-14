# CI quality gates

`.github/workflows/ci.yml` validates pull requests and pushes to `main` with the same core gates used
locally on a macOS runner:

```bash
vp install --frozen-lockfile
vp run --filter @t3tools/desktop ensure:electron
vp check
vp run typecheck
vp run test
vp run build:desktop
vp run test:desktop-smoke
```

The smoke test fails when Electron exits early, exits nonzero, or reports a fatal module/runtime
error. It succeeds only after observing a concrete desktop-readiness log or after the process remains
healthy for the bounded smoke-test window.

`.github/workflows/release.yml` is a separate manual, macOS-only artifact workflow. Neither workflow
deploys a hosted web app, mobile app, relay service, or release announcement.
