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

## Release policy

Releases are **scheduled automatically** at midnight UTC daily (19:00 ET /
16:00 PT) by `.github/workflows/release-scheduled.yml`. The job:

1. Checks for new commits since the last `v*` tag — skips if none.
2. Computes the next version using **capped-digit carry**:
   `patch ∈ [0..9]`, `minor ∈ [0..9]`, `major ∈ [0..∞]`.
   Examples: `1.0.0 → 1.0.1 → … → 1.0.9 → 1.1.0 → … → 1.9.9 → 2.0.0`.
3. Updates `VERSION`, `package.json`, `sidecar/package.json`,
   `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and regenerates
   both `package-lock.json` files.
4. Commits + tags with the `opensource@slrsoft.ca` SSH signing key
   (`Verified` badge on GitHub) and pushes — which triggers `release.yml`.
5. `release.yml` builds + signs + notarizes all platforms and
   **auto-publishes** the release (no draft).

### Manual escape hatch

If you need to cut a release outside the schedule, trigger
`bump-version.yml` manually:

```bash
gh workflow run bump-version.yml
# or: Actions tab → Bump Version → Run workflow
```

It uses the same capped-digit carry math and force-bumps even when there
are no new commits.

### Required secrets for signed commits/tags

In addition to the Apple/Tauri secrets above, the bump workflows need:

```bash
# SSH signing key — generates Verified commits/tags
gh secret set OPENSOURCE_SSH_KEY < ~/dev/secrets/ssh/opensource_ed25519
gh secret set OPENSOURCE_ALLOWED_SIGNERS < ~/dev/secrets/ssh/opensource_allowed_signers
```

The matching public key must also be registered on GitHub under
**Settings → SSH and GPG keys → New SSH key → Type: Signing Key** for
the account that owns `CLAWDUI_TOKEN`.

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
