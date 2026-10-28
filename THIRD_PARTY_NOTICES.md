# Third-party notices

Distributed builds of ProtoArt Press bundle the following software. Their full license texts are
shipped inside the app at `ProtoArt Press.app/Contents/Resources/Licenses/`.

| Component | License | Notes |
|---|---|---|
| Electron 44.7.0 | MIT | `Electron-LICENSE.txt` |
| Chromium (bundled in Electron), including libjpeg-turbo, libpng, zlib and others | BSD-3-Clause and various | `LICENSES.chromium.html` |
| Node.js (bundled in Electron), including zlib | MIT and various | Covered by `LICENSES.chromium.html` and the Electron license |

Build-time tools (`@electron/fuses` and its dependencies, MIT/ISC/Apache-2.0) aren't included in the
app.

The app uses fonts installed with macOS (for example DIN Condensed, Marker Felt and Futura); no fonts
are bundled. The app icon and all artwork are original to this project.
