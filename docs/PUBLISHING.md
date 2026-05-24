# Publishing Guide

This guide is for ClawdUI maintainers and fork owners who want to produce
signed, notarized release builds via GitHub Actions.

## One-time secret setup

All signing material is read from GitHub Actions secrets. Set them with the
`gh` CLI (run from the repo root):

```bash
# CLAWDUI_TOKEN — required so bump-version.yml's tag push triggers release.yml.
# GitHub's anti-recursion policy suppresses workflow events from pushes made with
# the default GITHUB_TOKEN, so we push the version tag with a PAT instead.
# Create at: https://github.com/settings/personal-access-tokens/new
# Scopes: contents (write), workflows (write). Save the token, then:
gh secret set CLAWDUI_TOKEN

# Apple signing (macOS notarized .dmg) — Developer ID Application cert
base64 -i developer_id.p12 | gh secret set APPLE_CERTIFICATE
gh secret set APPLE_CERTIFICATE_PASSWORD          # password used when exporting the .p12
gh secret set APPLE_SIGNING_IDENTITY              # "Developer ID Application: <name> (<TEAMID>)"
gh secret set APPLE_TEAM_ID                       # XXXXXXXXXX — your Apple Developer Team ID

# Notarization — App Store Connect API key (preferred over app-specific password)
# Create at https://appstoreconnect.apple.com/access/users → Integrations → App Store Connect API → Keys
# Download AuthKey_<KEY_ID>.p8 — save it locally, you can only download it once
gh secret set APPLE_API_KEY_ID                    # 10-char key ID, e.g. ABC1234XYZ
gh secret set APPLE_API_ISSUER                    # UUID, e.g. 1a234567-89bc-def0-1234-567890abcdef
base64 -i AuthKey_<KEY_ID>.p8 | gh secret set APPLE_API_KEY

# Tauri updater signing (for the built-in updater plugin)
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/clawdui.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD

# Optional: crash / error reporting
gh secret set GLITCHTIP_DSN
```

### Generating a Tauri updater key

```bash
# One-time: generate Tauri updater keypair
npx @tauri-apps/cli signer generate -w ~/.tauri/clawdui.key
# Copy public key from output, paste into tauri.conf.json "pubkey"
# Set TAURI_SIGNING_PRIVATE_KEY secret = contents of ~/.tauri/clawdui.key
```

The public key goes into `src-tauri/tauri.conf.json` under
`plugins.updater.pubkey`. The private key is the secret set above.

### Apple certificate export

1. In Keychain Access, find your "Developer ID Application" certificate.
2. Right-click, Export, choose Personal Information Exchange (.p12).
3. Pick an export password. That password is `APPLE_CERTIFICATE_PASSWORD`.
4. Base64-encode it and feed to `gh secret set` as shown above.

## Cutting a release

You have two options:

### Option A: Manual tag

```bash
git tag v1.0.0
git push origin v1.0.0
```

The `release.yml` workflow triggers on `v*` tags, builds all platforms,
signs the macOS bundles, and creates a draft GitHub Release.

### Option B: Trigger `bump-version.yml`

From the Actions tab, run "Bump Version" and pick `patch`, `minor`, or
`major`. The workflow:

1. Reads the current version from `package.json`.
2. Bumps it per your choice.
3. Updates `package.json`, `src-tauri/Cargo.toml`,
   `src-tauri/tauri.conf.json`, and `VERSION`.
4. Commits with `chore(version): bump to vX.Y.Z`.
5. Tags `vX.Y.Z` and pushes (using `CLAWDUI_TOKEN`) — which triggers `release.yml`.

## Verifying signed builds

After download:

```bash
# macOS
spctl --assess --type execute --verbose=4 /Applications/ClawdUI.app
codesign --verify --deep --strict --verbose=2 /Applications/ClawdUI.app

# Should report: accepted, source=Notarized Developer ID
```

## Required platforms

The release matrix builds:

| Platform     | Runner          | Output           |
|--------------|-----------------|------------------|
| macOS arm64  | `macos-14`      | `.dmg`, `.app`   |
| macOS x86_64 | `macos-13`      | `.dmg`, `.app`   |
| Windows x64  | `windows-latest`| `.msi`, `.exe`   |
| Linux x64    | `ubuntu-22.04`  | `.deb`, AppImage |
