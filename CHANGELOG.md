# Changelog

## 2.2.1: a safer video engine

- **Video has a new native engine.** The old one (a JavaScript-for-Automation script) never freed the video frames
  it decoded, so a long or large video could use up the Mac's memory until macOS froze or restarted. The new engine
  is a small Swift program that frees each frame as soon as it's encoded: memory stays flat (about 20 MB) however
  long the video. A 2.3 GB, 1080p MP4 now presses in about 8 minutes with nothing else on the Mac slowing down.
- **Memory guard**: while a video encodes, Press checks the engine every second and stops it if it ever uses more
  than a third of the Mac's memory or macOS reports critically low memory. The file is then marked "Stopped" and
  nothing is written.
- The video engine runs at low priority, so the rest of the Mac stays responsive.
- Videos with transparency (HEVC with alpha, as Procreate, Motion and Final Cut export) are kept as they are
  instead of failing; re-encoding would lose the see-through parts. Videos that macOS can't decode straight to
  the usual frame format get a second try with full RGB frames.
- Building from source now needs Apple's command line tools (`xcode-select --install`) to compile the video engine.

## 2.2.0: CONVERT

- **MODE · CONVERT**: a new mode beside COMPRESS that changes photos instead of shrinking them. It reads JPEG, PNG,
  HEIC, TIFF, WebP, AVIF, GIF, BMP, PSD and camera RAW (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2), and writes JPEG,
  PNG, HEIC, WebP or TIFF, with a QUALITY knob for the lossy formats.
- **SIZE and FIT**: shrink to a pixel size along the long side, the width or the height, or to 50% / 25%. Never enlarges.
- **RENAME** with a pattern: the original name, a number in the order added (001…), the day the photo was taken, the
  new width and height. Characters that can't be in a file name become "-".
- **WATERMARK**: text or a logo (PNG or JPEG), nine positions, 25–100% opacity, three sizes, light or dark ink.
- **RECIPES**: save every CONVERT setting under a name and pick it again later.
- Results go into a "Converted" folder (or REPLACE, with originals to the Trash), upright and in sRGB. Camera details
  carry over from JPEG to JPEG as METADATA allows; other conversions carry none, so a location never comes along.
- How it works: the panel's own image engine decodes, resizes (the same Lanczos filter as COMPRESS), watermarks and
  encodes JPEG, PNG and WebP; HEIC, TIFF and RAW are opened by macOS's Core Image, and HEIC and TIFF are written by
  macOS's `sips`. Nothing new is downloaded or installed, and Press still makes no network connections.

## 2.1.1

- The window fits smaller screens: where the screen has less room than the panel (a 13" MacBook at a larger text
  size, or with the Dock showing), the whole panel scales down to fit (to 60% at most), so LOAD, CLEAR and the
  output settings along the bottom stay on screen. It re-fits when moved to another display. Nothing changes on
  larger screens.
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
