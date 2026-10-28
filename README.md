# ProtoArt Press

**Images, PDFs, video and audio made smaller, in a studio rack unit.**

ProtoArt Press is a free, open-source macOS app that compresses photos, PDFs, videos and audio files.
It uses its own perceptually checked image and PDF engines and macOS's built-in engines
(AVFoundation, Core Audio, and Quartz as a PDF fallback) for everything else, so there's nothing extra
to install.

Everything runs on your Mac. Nothing is uploaded, and the app makes no network connections.

## Features

Each format has its own module with an IN button, quality buttons (GENTLE / BALANCED / AGGRESSIVE),
a stepped size knob and a format choice:

- **Image (JPG, PNG):** finds the lowest JPEG quality that stays within a per-photo damage budget
  (SSIM, average and worst 64×64 region); PNGs are repacked losslessly, with optional invisible
  256-color reduction. Max size (long edge).
- **PDF:** recompresses only the pictures inside; text, fonts and vector art are copied untouched. Each
  picture is resized to the chosen resolution (300–72 dpi) based on how large it's shown on the page,
  then re-encoded with the same SSIM check as photos. Black-and-white pictures become one-channel
  JPEGs; GRAY makes every picture black-and-white. Unusual PDFs fall back to macOS's Quartz filter.
  Password-protected PDFs are skipped.
- **Video (MP4, MOV, M4V):** re-encodes the picture with Apple's hardware HEVC or H.264 encoder at a
  constant quality with a keyframe at least every 5 s; compressed audio is copied untouched and
  uncompressed audio becomes 160 kbps AAC; rotation is kept; optional downscale (4K–540p).
  HDR and copy-protected videos are skipped for now.
- **Audio (WAV, AIFF, FLAC, MP3, M4A, CAF):** AAC at 256/192/128 kbps (stereo) or Apple Lossless,
  optional lower sample rate; output is `.m4a`. Tags aren't carried over yet.
- **Global:** minimum saving (1/3/5/10%), output to a `Pressed` folder or replace in place (originals go
  to the Trash), metadata (keep / remove location / strip all).
- Click **ABOUT** in the app for a description of every control.

## Requirements

- A Mac with Apple Silicon (M1 or newer). Intel Macs aren't supported.
- macOS 13 or newer.

## Install a release

1. Download `ProtoArt-Press-<version>.dmg` and its `.sha256` from the
   [Releases](../../releases) page.
2. Check the download: `shasum -a 256 ProtoArt-Press-<version>.dmg` must print exactly the value in
   the `.sha256` file and the release notes. If it doesn't, delete it.
3. Open the DMG and drag **ProtoArt Press** to Applications.
4. The first time you open it, macOS warns that it can't verify the developer, because releases aren't
   notarized yet. Click **Done**, open **System Settings → Privacy & Security**, click **Open Anyway**
   next to ProtoArt Press, and confirm. You only need to do this once.

## Build from source

```bash
npm ci                 # pinned build tools (Electron 44.7.0, @electron/fuses)
npx install-electron   # downloads Electron and verifies its published checksum
npm test               # engine and security regression tests
npm run build          # makes "ProtoArt Press.app" (or double-click "Build ProtoArt Press.command")
npm run dmg            # optional: tests, builds and packs dist/ProtoArt-Press-<version>.dmg
```

The build copies Electron, adds the app files, removes unused permission entries, sets Electron fuses
(no Node mode, no `NODE_OPTIONS` or inspector flags, no extra `file://` privileges), adds license
notices and signs the app ad hoc. It stops if any step fails.

## How it's put together

| Path | What it does |
|---|---|
| `app/main.js` | Main process: queue, file I/O, folder scanning, PNG worker pool, IPC, menu |
| `app/fsafe.js` | Symlink-safe folder scanning and atomic output writes |
| `app/validate.js` | Validation for everything the panel sends to the main process |
| `app/preload.js` | The narrow bridge the panel can use (sandboxed) |
| `app/engine/` | SSIM, resizing, PNG decoder/encoder/quantizer and optimizer (plain JS + Node zlib) |
| `app/renderer/` | The rack panel and the JPEG worker (Chromium's codecs) |
| `tests/` | `node --test` suites |

## Privacy and security

- [PRIVACY.md](PRIVACY.md): what's stored, and confirmation that nothing is sent anywhere.
- [SECURITY.md](SECURITY.md): how to report a vulnerability, and the app's security design.

## License

Apache License 2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
