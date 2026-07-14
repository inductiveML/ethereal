# Desktop release notes

The Phase 1 release path builds an unsigned Ethereal macOS DMG. The workflow is manual and uploads a
GitHub Actions artifact; it does not publish a GitHub Release. Apple Silicon (`arm64`) is the default,
with an `x64` option retained for Intel Macs.

The workflow runs install, check, typecheck, tests, desktop build, and the desktop smoke test before
packaging. Packaging does not discover signing or notarization credentials during Phase 1.

## Local packaging

Build an unsigned artifact locally with one of:

```bash
vp run dist:desktop:dmg         # host architecture
vp run dist:desktop:dmg:arm64   # Apple Silicon
vp run dist:desktop:dmg:x64     # Intel
```

Artifacts are written to `./release` as `Ethereal-<version>-<arch>.dmg`. Append script options to the
Vite+ command; for example, `vp run dist:desktop:dmg:arm64 --keep-stage --verbose` preserves the
staging directory and streams packaging output.

## Release scope

Phase 1 intentionally has no Windows or Linux packaging, nightly channel, auto-updater manifest
generation, mobile release, hosted web deployment, relay deployment, automatic publishing, or
release announcement integration. Add signing, notarization, and publishing only after the Ethereal
application identity and distribution account are finalized.
