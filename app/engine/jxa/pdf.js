// ProtoArt Press PDF engine (JavaScript for Automation, run by /usr/bin/osascript).
// Re-compresses the pictures inside a PDF with a Quartz filter. Text and vector
// artwork are written back unchanged. argv[0] is a JSON job; prints JSON on stdout.
ObjC.import('Foundation'); ObjC.import('Quartz'); ObjC.import('AppKit');

function isNil(x) { return x === null || x === undefined || (typeof x.isNil === 'function' && x.isNil()); }

function filterFor(job) {
  const scale = { ImageScaleInterpolate: true, ImageSizeMin: 128 };
  if (job.dpi > 0) scale.ImageResolution = job.dpi;
  const image = { 'Compression Quality': job.quality, ImageCompression: 'ImageJPEGCompress', ImageScaleSettings: scale };
  let filter;
  if (job.gray) {
    // Start from macOS's own "Gray Tone" filter and add our picture settings to it.
    const data = $.NSData.dataWithContentsOfFile('/System/Library/Filters/Gray Tone.qfilter');
    if (isNil(data)) throw new Error('The macOS gray filter is missing');
    filter = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(data, 2 /* mutable containers and leaves */, null, null);
    if (isNil(filter)) throw new Error('The macOS gray filter is unreadable');
    let fd = filter.objectForKey('FilterData');
    if (isNil(fd)) { fd = $.NSMutableDictionary.dictionary; filter.setObjectForKey(fd, 'FilterData'); }
    let cs = fd.objectForKey('ColorSettings');
    if (isNil(cs)) { cs = $.NSMutableDictionary.dictionary; fd.setObjectForKey(cs, 'ColorSettings'); }
    cs.setObjectForKey($(image), 'ImageSettings');
    filter.setObjectForKey($('ProtoArt Press'), 'Name');
  } else {
    filter = $({ Domains: { Applications: true, Printing: true }, FilterType: 1, Name: 'ProtoArt Press', FilterData: { ColorSettings: { ImageSettings: image } } });
  }
  if (!filter.writeToFileAtomically(job.filter, true)) throw new Error("Couldn't prepare the PDF filter");
  const qf = $.QuartzFilter.quartzFilterWithURL($.NSURL.fileURLWithPath(job.filter));
  if (isNil(qf)) throw new Error("Couldn't load the PDF filter");
  return qf;
}

/**
 * True when every page looks gray (black-and-white scans, text-only documents): samples a
 * small thumbnail of up to 24 pages spread through the document and checks colorfulness.
 */
function looksGray(doc) {
  const pages = Number(doc.pageCount);
  const step = Math.max(1, Math.floor(pages / 24));
  for (let i = 0; i < pages; i += step) {
    const img = doc.pageAtIndex(i).thumbnailOfSizeForBox({ width: 40, height: 40 }, 1 /* crop box */);
    const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
    if (isNil(rep)) return false;
    const w = Number(rep.pixelsWide), h = Number(rep.pixelsHigh);
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const c = rep.colorAtXY(x, y).colorUsingColorSpace($.NSColorSpace.sRGBColorSpace);
        if (isNil(c)) continue;
        const r = c.redComponent, g = c.greenComponent, b = c.blueComponent;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 0.08) return false; // a colored pixel
      }
    }
  }
  return true;
}

function press(job) {
  const t0 = Date.now();
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(job.src));
  if (isNil(doc)) return { ok: true, kept: "macOS can't read this PDF, kept as is" };
  if (doc.isEncrypted || doc.isLocked) return { ok: true, kept: 'Password-protected PDF, kept as is' };
  const pages = Number(doc.pageCount);
  if (pages < 1) return { ok: true, kept: 'Empty PDF, kept as is' };
  if (job.metadata === 'stripAll') doc.documentAttributes = $({});
  let autoGray = false;
  if (!job.gray && job.autoGray) {
    try { autoGray = looksGray(doc); } catch (e) { autoGray = false; }
    if (autoGray) job.gray = true;
  }
  const qf = filterFor(job);
  if (!doc.writeToURLWithOptions($.NSURL.fileURLWithPath(job.dst), $({ QuartzFilter: qf }))) throw new Error("Couldn't write the PDF");
  const check = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(job.dst));
  if (isNil(check) || Number(check.pageCount) !== pages) throw new Error('The pressed PDF did not check out, so nothing was written');
  return { ok: true, pages, autoGray, seconds: (Date.now() - t0) / 1000 };
}

function run(argv) {
  let job;
  try { job = JSON.parse(argv[0]); } catch (e) { return JSON.stringify({ ok: false, error: 'Bad job' }); }
  try { return JSON.stringify(press(job)); } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
}
