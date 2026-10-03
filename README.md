# Household Ledger

An offline household ledger for Windows, built with Electron. Expense data and receipt images are stored on the local PC; application updates replace program files without touching the app's user-data directory.

## Install and update

- When moving from an unpacked/older build, run the NSIS Setup installer once.
- After that, the app checks for updates shortly after launch and downloads them in the background.
- When an update is ready, choose **今すぐ再起動** to apply it, or **後で** to install it the next time the app exits.

## Development

```powershell
npm ci
npm run dev
```

Validation and local packaging:

```powershell
npm run typecheck
npm run test:database
npm run test:ocr
npm run dist
npm run test:packaged-ocr
```

The setup installer and unpacked app are written under `dist/auto-update/`.

## Publish a release

Update the version in `package.json` and `package-lock.json`, then either push a matching `v<version>` tag (for example `v0.1.3`) or run **Build and publish Windows release** manually from GitHub Actions. The workflow builds and tests the NSIS app, then publishes the installer, blockmap, and `latest.yml` to a public GitHub Release. Installed copies use those files to check for updates.

Never commit `tmp/`, `dist/`, `out/`, or `graphify-out/`; these are local data, generated files, or build outputs.
