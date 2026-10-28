# Security

## Reporting a vulnerability

Please report security problems privately using GitHub's **Report a vulnerability** button on this
repository's **Security** tab, not in a public issue. Include the macOS version, the ProtoArt Press
version, and steps or a sample file that reproduce the problem. You should get a reply within a week.

## Supported versions

Only the latest release gets security fixes.

## Security design

ProtoArt Press processes files that may come from anywhere, so it treats every file as untrusted.

- **Sandboxed renderer:** the panel runs with Chromium's OS sandbox, `contextIsolation`, no Node
  integration and no devtools. It's served from a custom `app://press/` origin that serves only an
  allowlist of panel files, under a strict Content-Security-Policy.
- **No network:** all non-local requests are blocked at the session level, and the app contains no
  network code, telemetry, analytics, crash reporting or auto-update.
- **No device access:** every permission request (camera, microphone, location, …) is denied, and the
  corresponding macOS usage entries are removed from the app bundle.
- **Narrow IPC:** the preload exposes a few functions. The main process accepts messages only from the
  panel page, validates every value against an allowlist, never sends full file paths to the panel,
  and checks that JPEG results are well formed before writing them.
- **Safe file handling:** folder scans skip symlinks and never leave the chosen folder. Output is written
  to a new exclusive temp file and atomically renamed into place, so it can never write through a
  symlink. A `Pressed` folder that is a symlink or resolves elsewhere is refused. REPLACE mode moves
  originals to the Trash.
- **PDF engine:** Press's own PDF reader/writer runs in a Node worker thread with memory limits. It
  decodes only Flate/ASCII85/ASCIIHex streams with hard output caps, never follows a content stream
  more than 12 Form XObjects deep, skips pictures over 100 megapixels, leaves encrypted files alone,
  and re-reads every PDF it writes (page count must match) before it's used. Pictures are re-encoded
  by the sandboxed panel's JPEG engine and validated on the way back. Anything it can't handle goes
  to the macOS path below.
- **macOS helpers:** PDFs (fallback), videos and audio are processed by macOS's own frameworks (PDFKit/Quartz,
  AVFoundation, Core Audio) in separate processes: `/usr/bin/osascript` running the app's bundled
  scripts, `/usr/bin/afconvert` and `/usr/bin/afinfo`. They're started with fixed absolute paths and
  argument arrays (never a shell), a minimal environment, and absolute file paths only. They write into a
  private temp folder (mode 0700); results are checked (page count, duration, channel count) and then
  moved into place with the same symlink-safe rename. Helpers are stopped when the app quits.
- **Resource limits:** images over 150 megapixels or 512 MB are left alone, PNG pixel data is inflated
  with a hard size cap, and the PNG worker has memory limits.
- **Hardened Electron:** fuses disable Node mode, `NODE_OPTIONS`, inspector flags and extra `file://`
  privileges.

## Known limitations

- Releases are signed ad hoc, not notarized, so macOS shows a warning on first launch. Always check the
  SHA-256 of a download against the release notes.
- The macOS helper processes aren't in Chromium's sandbox; they're the same system frameworks Finder
  and Quick Look use to read these files.
- The app's JavaScript isn't packaged in an asar archive with integrity checking yet.
