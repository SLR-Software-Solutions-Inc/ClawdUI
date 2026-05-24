# Fastlane — ClawdUI

Local-only release tooling for ClawdUI on macOS. Produces:

1. **Mac App Store `.pkg`** — codesigned with `3rd Party Mac Developer Application/Installer`, ready for `deliver`-based upload to App Store Connect.
2. **Direct-distribution `.dmg`** — codesigned with `Developer ID Application`, notarized via `xcrun notarytool`, stapled.

> **Builds stay on this machine.** No CI publishes any artifact. Apple credentials live exclusively in `<your-env-file>` and `<your-asc-key-dir>/AuthKey_*.p8`.

## Prereqs

- macOS with Xcode command-line tools (`xcrun --find codesign`, `xcrun notarytool`)
- Ruby + bundler (`brew install rbenv` recommended)
- `fastlane` 2.220+
- `match`-managed certs synced (run `fastlane mac sync_certs` once)

## Setup

```sh
# 1. Install fastlane via bundler (one-time per machine)
bundle install                # uses repo-root Gemfile, pins fastlane version

# 2. Source secrets
set -a && . <your-env-file> && set +a

# 3. Sanity check
bundle exec fastlane mac setup_env
```

> Always invoke fastlane through `bundle exec` so the locked version is used. Plain `fastlane` may resolve to a globally-installed gem with a different release.

`setup_env` writes `fastlane/apple_api_key.json` from the ASC `.p8` key. That file is gitignored.

> `fastlane/README.md` is auto-regenerated on every `fastlane` run. Do not edit it — edit this file (`RELEASING.md`) instead.

## Lanes

| Lane | What it does | Side effects |
|------|--------------|--------------|
| `setup_env` | Verifies env vars and writes ASC API key JSON | Creates `fastlane/apple_api_key.json` (gitignored) |
| `register_bundle_id` | Registers `ca.slrsoft.clawdui` on the Apple Developer Portal via ASC API | Creates new Bundle ID record (one-time per app) |
| `match_bootstrap` | One-time `match` push for the App Store cert + profile | Generates cert on Apple Dev Portal, encrypts + commits to `MATCH_GIT_URL` |
| `sync_certs` | `match` pull (read-only) for App Store cert + profile | Imports cert into login keychain |
| `build_appstore` | Tauri build → codesign with `Apple Distribution` → `productbuild` signed `.pkg` | `.pkg` under `src-tauri/target/<arch>/release/bundle/macos/` |
| `upload_appstore pkg:<path>` | Uploads a signed `.pkg` to App Store Connect via `deliver` | No metadata / screenshots / submit-for-review touched |
| `build_dmg_notarized` | Tauri build → codesign with `Developer ID Application` (keychain) → notarize via `notarytool` → staple | Notarized `.dmg` |
| `build_both` | Runs `build_appstore` then `build_dmg_notarized` | Both artifacts |

## Cert ownership

| Cert | Source | Why |
|------|--------|-----|
| `Apple Distribution: …` | match (`MATCH_GIT_URL`, encrypted) | One per app/team. Used to sign the `.app` bundled into the App Store `.pkg`. |
| `3rd Party Mac Developer Installer: …` | Local keychain (account-level) | Used by `productbuild` to sign the `.pkg`. Pre-existing on the team Mac. |
| `Developer ID Application: …` | Local keychain (account-level) | Used to codesign the `.app` for direct (DMG) distribution. Account-level cert — Apple allows only one per team. Match cannot create it via ConnectAPI today (rejects `DEVELOPER_ID_APPLICATION_G2`). |
| `Developer ID Installer: …` | Local keychain (account-level) | Optional — only if signing a `.pkg` for direct distribution outside the App Store. |
| ASC API key (`AuthKey_*.p8`) | `<your-asc-key-dir>/` | Read by `notarytool`, `produce`, `deliver`, and `match`. |

Override the architecture per call: `fastlane mac build_appstore target:x86_64-apple-darwin`. Defaults to `aarch64-apple-darwin`.

## Entitlements

| File | Used for |
|------|----------|
| `src-tauri/entitlements.appstore.plist` | App Store build (sandboxed, hardened runtime) |
| `src-tauri/entitlements.developer-id.plist` | Notarized DMG (hardened runtime, no sandbox) |

Edit those files (not the Fastfile) if Claude Agent SDK ever requires additional entitlements (e.g. file-system-access scopes for paths beyond the sandbox container).

## What never leaves this machine

- `fastlane/apple_api_key.json` (regenerated each run from `<your-local-secrets-dir>`)
- `fastlane/.env` (if you opt to use one)
- `fastlane/README.local.md` (if it exists — gitignored for personal notes)
- The `.p12` cert files (lived in `<your-cert-backup-dir>/` and the apple-devops `keystore` branch — never copied into this repo)
