# Contributing to Pulse Metric Studio

Thanks for helping improve Pulse Metric Studio.
The process is deliberately light.

## Getting set up

```sh
npm ci
npm run build
npm run tauri:dev
```

Desktop builds need the Rust toolchain and the native Tauri prerequisites for your operating system.
Use Node.js 22.15 or newer.
[AGENTS.md](AGENTS.md) describes where code lives and the repository rules.

## Before you open a pull request

Run these checks and make sure they are green:

```sh
npm run typecheck
npm run check:architecture
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

On a fresh checkout, run `npm run build` and `node scripts/copy-resources.mjs` before the Rust tests.
Desktop and live Tableau workflows need manual verification on the platforms your change affects.

## Pull request expectations

- Keep the change focused and describe what you changed and why.
- New behavior comes with unit tests; automated tests never call live Tableau or AI services.
- Do not commit credentials, databases, logs, or build output.

## Publish a release

Releases are assembled locally and published by hand, to two separate channels from the same build.
Internal releases go to `sfdc-qbranch-emu/pulse-metric-studio` (private), and public releases to `ahillspace/pulse-metric-studio`.
The installer records the repository it installed from, and the app only ever updates from that repository, so the two channels never mix.

1. Bump the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`.
2. Build the macOS DMG on a Mac with `APPLE_SIGNING_IDENTITY="<identity>" npm run tauri:build`.
3. Take the Windows installer from the CI run for the same commit: the `native` job uploads it as the `pulse-metric-studio-windows-2022-x64` artifact. Download it with `gh run download <run-id> --name pulse-metric-studio-windows-2022-x64 --dir windows-artifacts`.
4. Stage the release once per channel, so each copy of the install scripts defaults to its own repository:
   `sh scripts/stage-release.sh --repo OWNER/NAME release-assets-NAME "windows-artifacts/nsis/Pulse Metric Studio_X.Y.Z_x64-setup.exe"`.
   This renames the installers, adds the install scripts, and writes `checksums.txt`.
5. For each channel, upload a draft with `gh release create vX.Y.Z release-assets-NAME/* --draft --repo OWNER/NAME`, then publish it with `gh release edit vX.Y.Z --draft=false --latest --repo OWNER/NAME`.
   The one-line installers and the in-app update check use the latest published release, so drafts stay invisible to them.

`checksums.txt` confirms a download is intact; it does not prove who published it.

## Signing

`bundle.macOS.signingIdentity` in `src-tauri/tauri.conf.json` stays at the ad-hoc `"-"` identity as a safe default.
Set `APPLE_SIGNING_IDENTITY` to sign with a real identity; the maintainer's builds use the same self-signed identity as the maintainer's other apps.
Keychain access does not depend on the signature: the app saves each secret through the system `security` tool, so Keychain trusts that tool rather than the app, and updates never ask again.
Notarization additionally needs an Apple Developer ID; without it, a browser download hits the Gatekeeper prompt once, which the one-line installer avoids.
Windows installers are unsigned, so a browser download shows a SmartScreen warning.

## Reporting bugs and requesting features

Open an issue with your platform, the app version, and the exact steps to reproduce.
