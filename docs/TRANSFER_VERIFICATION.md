# New Pulse version transfer

## Scope

The rebuilt Pulse app from the final local juju-local working tree replaces the older app in this repository.
The transfer preserves its UI, product decisions, workflows, SQLite schema, migrations, and provider behavior.

Destination adaptations cover the Pulse Metric Studio name, package scope, environment prefix, desktop identifier, and database filename.
The entry point loads Pulse Metric Studio directly.
The repository keeps its Git history, Apache 2.0 license, icons, and standalone development commands.

Source comparison found no missing files in the Pulse backend or Pulse UI feature directories.
Remaining differences in those directories concern branding, comments, and test fixture naming.
Independent reviews also checked native authentication, credential storage, startup, shutdown, and standalone package wiring.
Tauri JavaScript dependencies are pinned to the tested source versions so they remain compatible with the locked Rust dependencies.

The source repository and installed app data remain unchanged during this transfer.
Changes remain local and unpublished.

## Completed checks

| Check | Result |
| --- | --- |
| Workspace production build | Pass |
| Workspace TypeScript checks | Pass |
| Pulse architecture guard | Pass |
| Integrated Node test suite, including shared authoring rules | 418 passed; no failures or skips |
| Locked Rust tests | 15 passed |
| Source parity and independent implementation review | No blocking findings |
| Git whitespace check | Pass |

Automated tests use isolated local fixtures and controlled provider responses.
No desktop app or installer was launched during the transfer.
Live Tableau workflows and macOS runtime behavior were not requalified in this repository.

## Native artifacts

Windows x64 MSI and EXE installer packaging completed successfully.
The artifacts are `native-artifacts/msi/Pulse Metric Studio_0.1.0_x64_en-US.msi` and `native-artifacts/nsis/Pulse Metric Studio_0.1.0_x64-setup.exe`.
`native-artifacts/build-evidence.json` records their SHA-256 checksums, runtime versions, and the staged frontend and backend hashes.
The installers have not been launched or installed during this transfer.
Windows release qualification and macOS native qualification remain user-led steps.
