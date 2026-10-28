# Changelog

## 2.1.0: Own PDF picture optimizer

- PDFs are now read and rewritten by Press itself (no new programs): it finds every picture, works out
  how large it is shown on the page, resizes it to the chosen dpi (Lanczos) and re-encodes it with the
  same SSIM-checked search used for photos, with a per-strength quality floor (q80 / q75 / q56).
  Text, fonts and vector art are copied byte for byte.
- Black-and-white pictures (and every picture with COLOR: GRAY) are stored as true one-channel JPEGs,
  converted losslessly from the luminance channel.
- Benchmarked against PDF Squeezer Medium on the same files: about the same size, with pictures that
  match the originals more closely (picture SSIM 0.978 vs 0.971; scans 0.854 vs 0.836 at 144 dpi).
- PDFs the new engine can't improve or doesn't understand (encrypted, CMYK-only, unusual encodings,
  over 768 MB) fall back to the macOS Quartz path.
- Video: a keyframe at least every 5 seconds (as HandBrake does) and uncompressed or oversized sound
  becomes 160 kbps AAC; compressed sound is still copied untouched.

## 2.0.0: PA-2 media compressor

- New formats: PDF (Quartz filter, pictures only), video (AVFoundation HEVC/H.264, audio passthrough,
  rotation kept) and audio (Core Audio AAC or Apple Lossless).
- Redesigned panel: one hardware module per format with an IN button, lit quality buttons, a stepped knob
  and a format button pair. THRESHOLD is now MINIMUM SAVING buttons; OUTPUT and METADATA are button rows.
- Helpers run as child processes with fixed program paths and argument arrays (no shell), write only
  into a private temp folder, and results are moved into place with the same symlink-safe rename.
- Session log shows a type badge per file; sizes over 1 GB show in GB.

## 1.2.0: Security hardening (pre-release audit)

- Output writes can no longer follow symlinks out of the chosen folder (exclusive temp file plus atomic rename).
- Folder scans skip symlinks and can't loop.
- Renderer runs in Chromium's sandbox and is served from `app://press/` instead of `file://`.
- Every IPC message is sender-checked and validated; the panel no longer receives full file paths.
- Images over 150 MP or 512 MB are left alone; the PNG inflate size is capped; the PNG worker has memory limits.
- Permissions are denied and network requests blocked at the session level; unused macOS usage entries removed.
- Stricter Content-Security-Policy; extra `file://` privileges fuse disabled.
- Electron and Chromium license notices are included in the app.
- Default metadata mode is now NO GPS.
- Pinned build tools (`package.json` + lockfile); the build fails if hardening can't be applied.

## 1.1.0

- Black panel by default, tube-lit VU meter, About card, RESET button, double-click to reset dials, blue DONE LED.
- App menu, single instance, quit guard, DMG script.

## 1.0.0

- First version: JPEG SSIM quality search, lossless PNG plus palette reduction, rack-unit interface.
