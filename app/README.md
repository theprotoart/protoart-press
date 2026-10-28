# app/

Source for the ProtoArt Press Electron app. See the repository [README](../README.md) for building and
[SECURITY.md](../SECURITY.md) for the security design.

- `main.js`: main process (queue, file I/O, IPC, menu, panel protocol)
- `fsafe.js`: symlink-safe scanning and atomic writes
- `validate.js`: IPC input validation
- `preload.js`: sandboxed bridge exposed to the panel as `window.press`
- `engine/`: SSIM, resize, PNG codec and optimizer (also used by the PNG worker thread)
- `renderer/`: panel UI, procedural textures, JPEG web worker
- `build/icon.png`: app icon (`icon.html` regenerates it in a browser)
