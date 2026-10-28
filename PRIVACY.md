# Privacy

**ProtoArt Press makes no network connections.** There's no account, telemetry, analytics, crash
reporting or update check, and the app blocks network requests at the session level.

## What it reads and writes

- **Your files:** only the files and folders you drop or choose. Symlinks inside folders are skipped.
- **Output:** smaller copies in a `Pressed` folder beside the originals (COPY mode), or the originals
  replaced in place with the old files moved to the Trash (REPLACE mode).
- **Metadata:** by default (NO GPS) the GPS location is removed from JPEGs, and PNG EXIF and XMP
  metadata (which can carry a location) are dropped. KEEP carries camera info, dates and location over; STRIP ALL removes everything.
  The color profile is always kept. For videos, NO GPS removes location metadata and STRIP ALL removes
  all of it; for PDFs, STRIP ALL removes the title, author and keywords. Audio tags aren't carried over.
- **Temporary files:** PDF, video and audio results are made in a private folder inside your user
  temp folder and removed as soon as each file is finished.

## What it stores

- **Settings** (knob and switch positions, panel finish) in the app's local storage under
  `~/Library/Application Support/ProtoArt Press/`, along with Chromium's standard cache and
  preference files. No file names or paths are stored.
- **The session log** exists only while the app is open.
- The app writes no log files.

To remove everything, delete the app and `~/Library/Application Support/ProtoArt Press/`.
