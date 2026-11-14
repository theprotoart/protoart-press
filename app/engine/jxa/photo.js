// ProtoArt Press photo reader (JavaScript for Automation, run by /usr/bin/osascript).
// Opens a picture the panel can't decode itself (HEIC, TIFF, RAW, PSD…) with macOS's Core Image, turns it
// upright, and writes it as a PNG for CONVERT. Uses Objective-C classes only (no C functions or struct
// arguments), so it doesn't depend on BridgeSupport. argv[0] is a JSON job; prints JSON on stdout.
ObjC.import('Foundation'); ObjC.import('AppKit');
$.NSBundle.bundleWithPath('/System/Library/Frameworks/CoreImage.framework').load;

function isNil(x) {
  if (x === null || x === undefined) return true;
  if (typeof x.isNil === 'function') return x.isNil();
  try { const o = ObjC.castRefToObject(x); return !o || o.isNil(); } catch (e) { return false; }
}
const str = v => (isNil(v) ? '' : String(ObjC.unwrap(v)));
const num = v => (isNil(v) ? 0 : Number(ObjC.unwrap(v)));
const MAX_PIXELS = 150000000;

function decode(job) {
  const CIImage = $.NSClassFromString('CIImage');
  if (isNil(CIImage)) throw new Error('Core Image is unavailable');
  let img = CIImage.imageWithContentsOfURL($.NSURL.fileURLWithPath(job.src));
  if (isNil(img)) return { kept: "macOS can't read this picture, kept as is" };
  const props = img.properties;
  const w0 = num(props.objectForKey('PixelWidth')), h0 = num(props.objectForKey('PixelHeight'));
  if (w0 * h0 > MAX_PIXELS) return { kept: 'Too large to process safely, kept as is' };
  // Turn it upright (EXIF orientation 1–8), as Photos and Preview show it.
  const orientation = num(props.objectForKey('Orientation'));
  if (orientation > 1 && orientation <= 8) img = img.imageByApplyingCGOrientation(orientation);
  const exif = props.objectForKey('{Exif}');
  const taken = isNil(exif) ? '' : str(exif.objectForKey('DateTimeOriginal'));
  const rep = $.NSBitmapImageRep.alloc.initWithCIImage(img);
  if (isNil(rep)) throw new Error("Couldn't read the picture's pixels");
  const png = rep.representationUsingTypeProperties(4 /* PNG */, $({}));
  if (isNil(png) || !png.writeToFileAtomically(job.dst, true)) throw new Error("Couldn't prepare the picture");
  return { width: num(rep.pixelsWide), height: num(rep.pixelsHigh), taken };
}

function run(argv) {
  let job;
  try { job = JSON.parse(argv[0]); } catch (e) { return JSON.stringify({ ok: false, error: 'Bad job' }); }
  try {
    if (job.op !== 'decode') return JSON.stringify({ ok: false, error: 'Unknown job' });
    return JSON.stringify(Object.assign({ ok: true }, decode(job)));
  } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
}
