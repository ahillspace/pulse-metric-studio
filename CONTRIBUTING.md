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

Releases are assembled locally and published by hand.

1. Bump the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Build the macOS DMG on a Mac with `APPLE_SIGNING_IDENTITY="<identity>" npm run tauri:build`.
3. Take the Windows installer from the CI run for the same commit: the `native` job uploads it as the `pulse-metric-studio-windows-2022-x64` artifact. Download it with `gh run download <run-id> --name pulse-metric-studio-windows-2022-x64 --dir windows-artifacts`.
4. Run `sh scripts/stage-release.sh release-assets "windows-artifacts/nsis/Pulse Metric Studio_X.Y.Z_x64-setup.exe"`, which renames the installers, adds the install scripts, and writes `checksums.txt`.
   The staged install scripts default to `sfdc-qbranch-emu/pulse-metric-studio`; add `--repo OWNER/NAME` before the output directory to publish elsewhere.
5. Upload a draft with `gh release create vX.Y.Z release-assets/* --draft --repo sfdc-qbranch-emu/pulse-metric-studio`, then publish it with `gh release edit vX.Y.Z --draft=false --repo sfdc-qbranch-emu/pulse-metric-studio`.
   The one-line installers read `releases/latest/download`, so they only see published releases.

`checksums.txt` confirms a download is intact; it does not prove who published it.

## Signing

`bundle.macOS.signingIdentity` in `src-tauri/tauri.conf.json` stays at the ad-hoc `"-"` identity as a safe default.
Set `APPLE_SIGNING_IDENTITY` to sign with a real identity; the maintainer's builds use the same self-signed identity as the maintainer's other apps.
A stable identity matters here because macOS ties Keychain access to the app's signature: with it, approving Keychain access once survives updates.
Notarization additionally needs an Apple Developer ID; without it, a browser download hits the Gatekeeper prompt once, which the one-line installer avoids.
Windows installers are unsigned, so a browser download shows a SmartScreen warning.

## Reporting bugs and requesting features

Open an issue with your platform, the app version, and the exact steps to reproduce.
