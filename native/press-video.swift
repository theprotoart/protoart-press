// ProtoArt Press video engine: a small native helper (replaces the JavaScript-for-Automation script, whose
// per-frame objects were never freed during long encodes). Re-encodes the picture with AVFoundation at a
// constant quality (HEVC or H.264, optionally scaled down); audio is copied, or made AAC when it's uncompressed
// or very large. argv[1] is a JSON job; progress goes to stderr as "PROGRESS 0.123" lines and the result is
// one JSON line on stdout. Each frame is handled inside its own autorelease pool, so memory stays flat.
import AVFoundation
import Foundation

struct Job: Decodable {
    let src: String
    let dst: String
    let fileType: String
    let codec: String
    let quality: Double
    let maxEdge: Int
    let metadata: String
    let keyframeSeconds: Double
    let audioKbps: Int
}

enum EngineError: Error {
    case read(String)
    case other(String)
    var message: String {
        switch self {
        case .read(let m), .other(let m): return m
        }
    }
}

func emit(_ obj: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: obj) {
        FileHandle.standardOutput.write(data)
    } else {
        FileHandle.standardOutput.write(Data("{\"ok\":false,\"error\":\"Bad result\"}".utf8))
    }
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

func fail(_ msg: String) -> Never { emit(["ok": false, "error": msg]) }
func kept(_ msg: String) -> Never { emit(["ok": true, "kept": msg]) }

func progress(_ f: Double) {
    FileHandle.standardError.write(Data(String(format: "PROGRESS %.3f\n", min(1, max(0, f))).utf8))
}

func even(_ v: Double) -> Int { max(2, 2 * Int((v / 2).rounded())) }

func matches(_ s: String, _ pattern: String) -> Bool {
    s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
}

struct AudioPipe {
    let out: AVAssetReaderTrackOutput
    let input: AVAssetWriterInput
}

func encode(_ job: Job, pixelFormat: OSType) throws -> [String: Any] {
    let t0 = Date()
    try? FileManager.default.removeItem(atPath: job.dst) // the writer won't replace a file

    let asset = AVURLAsset(url: URL(fileURLWithPath: job.src), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    if !asset.isReadable { kept("macOS can't read this video, kept as is") }
    if asset.hasProtectedContent { kept("Copy-protected video, kept as is") }
    let vts = asset.tracks(withMediaType: .video)
    if vts.isEmpty { kept("No video track, kept as is") }
    if vts.count > 1 { kept("Several video tracks, kept as is") }
    let vt = vts[0]
    let desc = vt.formatDescriptions.first.map { String(describing: $0) } ?? ""
    if matches(desc, "ITU_R_2100|SMPTE_ST_2084|HLG|DolbyVision|'dvh1'|'dvhe'") { kept("HDR video, kept as is") }
    // HEVC with transparency (Procreate, Motion, Final Cut): re-encoding would lose the see-through parts.
    if matches(desc, "ContainsAlphaChannel\\s*=\\s*1|'muxa'|AlphaChannelMode") { kept("Video with transparency, kept as is") }

    let size = vt.naturalSize
    let (w, h) = (Double(size.width), Double(size.height))
    if !(w > 0 && h > 0) { throw EngineError.other("Unreadable video size") }
    let duration = CMTimeGetSeconds(asset.duration)
    let fps = vt.nominalFrameRate > 0 ? Double(vt.nominalFrameRate) : 30
    let expected = max(1, (duration.isFinite ? duration : 0) * fps)

    let s = job.maxEdge > 0 && max(w, h) > Double(job.maxEdge) ? Double(job.maxEdge) / max(w, h) : 1
    let ow = s < 1 ? even(w * s) : even(w), oh = s < 1 ? even(h * s) : even(h)

    // Rotation (phone videos): carry the transform over, scaling its offsets with the frame.
    var tf = vt.preferredTransform
    tf.tx *= CGFloat(Double(ow) / w)
    tf.ty *= CGFloat(Double(oh) / h)
    let rotated = abs(tf.b) > 0.5

    let reader: AVAssetReader
    do { reader = try AVAssetReader(asset: asset) } catch { throw EngineError.other("Couldn't open the video for reading") }
    let vout = AVAssetReaderTrackOutput(track: vt, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: pixelFormat])
    vout.alwaysCopiesSampleData = false
    guard reader.canAdd(vout) else { throw EngineError.other("This video can't be decoded") }
    reader.add(vout)

    let writer: AVAssetWriter
    do { writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: job.dst), fileType: AVFileType(rawValue: job.fileType)) } catch {
        throw EngineError.other("Couldn't create the output file")
    }
    writer.shouldOptimizeForNetworkUse = true
    let hevc = job.codec == "hevc"
    let vin = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
        AVVideoWidthKey: ow, AVVideoHeightKey: oh,
        AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
        AVVideoCompressionPropertiesKey: [
            AVVideoQualityKey: job.quality,
            AVVideoExpectedSourceFrameRateKey: Int(fps.rounded()),
            AVVideoProfileLevelKey: hevc ? "HEVC_Main_AutoLevel" : AVVideoProfileLevelH264HighAutoLevel,
            AVVideoAllowFrameReorderingKey: true,
            // Keyframes every few seconds (like HandBrake) instead of the encoder's frequent default.
            AVVideoMaxKeyFrameIntervalDurationKey: job.keyframeSeconds > 0 ? job.keyframeSeconds : 5,
        ] as [String: Any],
    ])
    vin.expectsMediaDataInRealTime = false
    vin.transform = tf
    guard writer.canAdd(vin) else { throw EngineError.other("This video format can't be written") }
    writer.add(vin)

    // Audio: copied as is, unless it's big (uncompressed or high bitrate) and audioKbps is set: then it's
    // re-encoded to AAC at that bitrate, as HandBrake's presets do.
    var audio: [AudioPipe] = []
    var audioNote = "copied"
    for at in asset.tracks(withMediaType: .audio) {
        let fd = at.formatDescriptions.first.map { $0 as! CMFormatDescription }
        let sub = fd.map { CMFormatDescriptionGetMediaSubType($0) } ?? 0
        let big = [kAudioFormatLinearPCM, kAudioFormatAppleLossless, kAudioFormatFLAC].contains(sub)
        let reencode = job.audioKbps > 0 && (big || Double(at.estimatedDataRate) > Double(job.audioKbps) * 1000 * 1.4)
        let out: AVAssetReaderTrackOutput, input: AVAssetWriterInput
        if reencode {
            var nch = 2
            if let fd, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd) {
                nch = max(1, min(2, Int(asbd.pointee.mChannelsPerFrame)))
            }
            out = AVAssetReaderTrackOutput(track: at, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
            input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVNumberOfChannelsKey: nch, AVSampleRateKey: 48000,
                AVEncoderBitRateKey: job.audioKbps * 1000 * nch / 2,
            ])
            audioNote = "AAC \(job.audioKbps)k"
        } else {
            out = AVAssetReaderTrackOutput(track: at, outputSettings: nil)
            input = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: fd)
        }
        if !reader.canAdd(out) { continue }
        input.expectsMediaDataInRealTime = false
        if !writer.canAdd(input) { kept("Its audio can't be copied into this format, kept as is") }
        reader.add(out)
        writer.add(input)
        audio.append(AudioPipe(out: out, input: input))
    }

    if job.metadata != "stripAll" {
        writer.metadata = asset.metadata.filter { item in
            let id = item.identifier?.rawValue ?? ""
            return !(job.metadata == "noGPS" && matches(id, "location|6709|xyz|gps"))
        }
    }

    guard reader.startReading() else { throw EngineError.read("Reading failed: \(reader.error?.localizedDescription ?? "couldn't start")") }
    guard writer.startWriting() else { throw EngineError.other("Couldn't start writing: \(writer.error?.localizedDescription ?? "")") }
    writer.startSession(atSourceTime: .zero)

    var vDone = false, frames = 0, broke = false
    var audioDone = [Bool](repeating: false, count: audio.count)
    while !vDone || audioDone.contains(false) {
        var worked = false
        autoreleasepool {
            if !vDone && vin.isReadyForMoreMediaData {
                if let sb = vout.copyNextSampleBuffer() {
                    if !vin.append(sb) { broke = true }
                    frames += 1
                    if frames % 15 == 0 { progress(Double(frames) / expected) }
                } else {
                    vin.markAsFinished()
                    vDone = true
                }
                worked = true
            }
            for i in audio.indices where !audioDone[i] && audio[i].input.isReadyForMoreMediaData {
                if let sb = audio[i].out.copyNextSampleBuffer() {
                    if !audio[i].input.append(sb) { audioDone[i] = true }
                } else {
                    audio[i].input.markAsFinished()
                    audioDone[i] = true
                }
                worked = true
            }
        }
        if broke || writer.status == .failed || reader.status == .failed { break }
        if !worked { usleep(2000) }
    }
    if reader.status == .failed {
        writer.cancelWriting()
        throw EngineError.read("Reading failed: \(reader.error?.localizedDescription ?? "unknown")")
    }
    if writer.status == .failed || broke {
        throw EngineError.other("Writing failed: \(writer.error?.localizedDescription ?? "unknown")")
    }
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    if writer.status != .completed { throw EngineError.other("Writing failed: \(writer.error?.localizedDescription ?? "unknown")") }

    // Check what we wrote: one video track, the same length.
    let check = AVURLAsset(url: URL(fileURLWithPath: job.dst), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    let d2 = CMTimeGetSeconds(check.duration)
    if check.tracks(withMediaType: .video).count != 1 || abs(d2 - duration) > max(0.5, duration * 0.02) {
        throw EngineError.other("The re-encoded video did not check out, so nothing was written")
    }
    progress(1)
    return [
        "ok": true, "frames": frames, "seconds": Date().timeIntervalSince(t0), "duration": duration,
        "width": rotated ? oh : ow, "height": rotated ? ow : oh, "resized": s < 1,
        "audioTracks": audio.count, "audio": audioNote,
    ]
}

guard CommandLine.arguments.count == 2, let job = try? JSONDecoder().decode(Job.self, from: Data(CommandLine.arguments[1].utf8)) else {
    fail("Bad job")
}
do {
    emit(try encode(job, pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange))
} catch EngineError.read(_) {
    // Some sources can't be decoded straight to 4:2:0 frames: try once more with full RGB frames.
    do { emit(try encode(job, pixelFormat: kCVPixelFormatType_32BGRA)) } catch let e as EngineError { fail(e.message) } catch { fail("\(error)") }
} catch let e as EngineError {
    fail(e.message)
} catch {
    fail("\(error)")
}
