# Releasing

1. Update `version` in `package.json` and `app/package.json`, and add a `CHANGELOG.md` entry.
2. `npm ci && npx install-electron && npm test`
3. Double-click **Make DMG for friends.command** (or `npm run dmg`). It runs the tests, builds, verifies
   the signature and license files, and writes `dist/ProtoArt-Press-<version>.dmg` plus `.sha256`.
4. Open the DMG on a clean account or Mac and check that the app launches, compresses a folder, and that
   **ABOUT** shows "Image decoding is sandboxed."
5. Tag the commit (`git tag v<version>`) and create a GitHub Release from that tag. Upload the `.dmg` and
   `.sha256`, and paste the SHA-256 into the release notes.
6. Never commit `dist/`, `.app` bundles, logs or test images; `.gitignore` covers them.
