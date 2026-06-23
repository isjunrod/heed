import FluidAudio
import Foundation

// heed-parakeet — resident sidecar. Loads Parakeet ASR + FluidAudio diarization ONCE, then
// serves newline-delimited JSON requests on stdin and writes JSON responses on stdout:
//   {"cmd":"transcribe","wav":"/path.wav","language":"es"}  -> {"ok":true,"text":"..."}
//   {"cmd":"diarize","wav":"/path.wav"}                     -> {"ok":true,"speakers":[...],"segments":[...]}
// Keeping models warm in one process is what makes the live path fast (no per-call reload).

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
        let s = String(data: data, encoding: .utf8) {
        print(s)
    }
    fflush(stdout)
}

func langEnum(_ s: String?) -> Language? {
    guard let s = s, !s.isEmpty, s != "auto" else { return nil }
    return Language(rawValue: s)
}

// --- Load models once (downloads CoreML from HuggingFace on first run — NO gated token) ---
let asrModels = try await AsrModels.downloadAndLoad(version: .v3)
// Two ASR managers, routed by language — measured: neither alone handles both well.
//   English  -> UnifiedAsrManager (one-shot): full long-form English, fastest (~115x).
//   Other    -> AsrManager + melChunkContext:false + dualDecodeArbitration:true + language hint:
//               stops v3's English-bias drift (issue #594) so Spanish transcribes correctly.
let asrEN = UnifiedAsrManager()
try await asrEN.loadModels()
let asrML = AsrManager(config: ASRConfig(melChunkContext: false, dualDecodeArbitration: true))
try await asrML.loadModels(asrModels)

// clusteringThreshold 0.74 (default 0.7 over-split similar voices, e.g. a 2-host podcast → 3).
// Measured: 0.74 yields the correct count on hard audio AND clean clips; >=0.76 over-merges.
// The Python side also drops residual phantom speakers as a safety net (_filter_spurious_speakers).
let diarizer = DiarizerManager(config: DiarizerConfig(clusteringThreshold: 0.74))
let diarModels = try await DiarizerModels.downloadIfNeeded()
diarizer.initialize(models: diarModels)

let converter = AudioConverter()

// --- Live STREAMING (Nemotron multilingual): real-time commit/partial ---
// Lazy-loaded on the first stream-start so the resident memory cost is only paid when the
// user actually records. 560ms chunk = lowest latency (~0.5s) with clean Spanish (eval'd).
// Gives a monotonically-growing partial (confirmed prefix never changes) — heed shows it
// directly, no re-render. finish() yields the final text == what was on screen (seamless stop).
// Per-channel ASR streaming sessions (mic + system) that SHARE the ~1.5 GB model weights
// (preloadShared) and only cost ~50 MB of state each — so we can transcribe BOTH the user's mic
// AND the remote/system channel live without doubling memory.
var streamShared: SharedNemotronMultilingualModels? = nil
var streamVariant: String? = nil
var streamMgrs: [String: StreamingNemotronMultilingualAsrManager] = [:]

func ensureStream(_ channel: String, _ language: String) async throws -> StreamingNemotronMultilingualAsrManager {
    let variant = StreamingNemotronMultilingualAsrManager.languageDirectory(for: language)
    if streamShared == nil || streamVariant != variant {
        let dir = try await StreamingNemotronMultilingualAsrManager.downloadVariant(languageCode: language, chunkMs: 560)
        streamShared = try await StreamingNemotronMultilingualAsrManager.preloadShared(from: dir)
        streamVariant = variant
        streamMgrs.removeAll()  // model variant changed → drop per-channel sessions
    }
    if streamMgrs[channel] == nil {
        let m = StreamingNemotronMultilingualAsrManager()
        try await m.loadFromShared(streamShared!)
        streamMgrs[channel] = m
    }
    let m = streamMgrs[channel]!
    await m.reset()
    await m.setLanguage(language)
    return m
}

// --- Live STREAMING diarization (Sortformer): speakers in real time ---
// Lazy-loaded on first diar-start. Streaming addAudio + process gives a growing speaker timeline
// (finalized segments are stable; max 4 speakers). Used live on the SYSTEM channel (the remote
// party); the mic is always "Me". The Python side drops phantom speakers (post-filter).
var diarStream: SortformerDiarizer? = nil

func ensureDiarStream() async throws -> SortformerDiarizer {
    if diarStream == nil {
        let cfg = SortformerConfig.default
        let d = SortformerDiarizer(config: cfg)
        let models = try await SortformerModels.loadFromHuggingFace(config: cfg, computeUnits: .all)
        d.initialize(models: models)
        diarStream = d
    }
    let d = diarStream!
    d.reset()
    return d
}

emit(["ready": true, "engine": "parakeet-fluidaudio"])

// --- Serve requests ---
while let line = readLine() {
    guard let data = line.data(using: .utf8),
        let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let cmd = req["cmd"] as? String
    else {
        emit(["ok": false, "error": "bad request"])
        continue
    }
    do {
        switch cmd {
        case "transcribe":
            guard let wav = req["wav"] as? String else {
                emit(["ok": false, "error": "no wav"]); continue
            }
            let samples = try converter.resampleAudioFile(path: wav)
            let lang = langEnum(req["language"] as? String)
            // English (or unspecified) -> Unified one-shot; everything else -> multilingual fix.
            let text: String
            if lang == nil || lang == .english {
                text = try await asrEN.transcribe(samples)
            } else {
                var state = try TdtDecoderState()
                text = try await asrML.transcribe(samples, decoderState: &state, language: lang).text
            }
            emit(["ok": true, "text": text])
        case "diarize":
            guard let wav = req["wav"] as? String else {
                emit(["ok": false, "error": "no wav"]); continue
            }
            let samples = try converter.resampleAudioFile(path: wav)
            let result = try diarizer.performCompleteDiarization(samples, sampleRate: 16000)
            let segs = result.segments.map {
                ["speaker": $0.speakerId, "start": Double($0.startTimeSeconds), "end": Double($0.endTimeSeconds)] as [String: Any]
            }
            let speakers = Array(Set(result.segments.map { $0.speakerId })).sorted()
            // Per-speaker 256-dim voice embedding (WeSpeaker v2) for cross-session recognition.
            // Duration-weighted centroid of each speaker's segment embeddings, L2-normalized — the
            // representative voiceprint the Python side matches against ~/.heed-app/voices.json.
            var sums: [String: [Float]] = [:]
            var weights: [String: Float] = [:]
            for s in result.segments {
                let dur = max(0.0, s.endTimeSeconds - s.startTimeSeconds)
                if sums[s.speakerId] == nil { sums[s.speakerId] = [Float](repeating: 0, count: s.embedding.count) }
                for i in 0..<s.embedding.count { sums[s.speakerId]![i] += s.embedding[i] * dur }
                weights[s.speakerId, default: 0] += dur
            }
            var embeddings: [String: [Any]] = [:]
            for (sid, vec) in sums {
                var norm: Float = 0
                for v in vec { norm += v * v }
                norm = norm.squareRoot()
                guard norm > 0 else { continue }
                embeddings[sid] = vec.map { Double($0 / norm) }
            }
            emit(["ok": true, "speakers": speakers, "segments": segs, "embeddings": embeddings])
        case "stream-start":
            // Open/reset a live streaming session for this channel ("mic" | "sys").
            let lang = (req["language"] as? String) ?? "en"
            let channel = (req["channel"] as? String) ?? "mic"
            _ = try await ensureStream(channel, lang)
            emit(["ok": true])
        case "stream-feed":
            // Append the NEW audio segment; return the growing partial (confirmed prefix is stable).
            let channel = (req["channel"] as? String) ?? "mic"
            guard let wav = req["wav"] as? String, let m = streamMgrs[channel] else {
                emit(["ok": false, "error": "no stream session"]); continue
            }
            let samples = try converter.resampleAudioFile(path: wav)
            _ = try await m.process(samples: samples)
            let partial = await m.getPartialTranscript()
            emit(["ok": true, "partial": partial])
        case "stream-finish":
            // End the stream → final text (== what was on screen).
            let channel = (req["channel"] as? String) ?? "mic"
            guard let m = streamMgrs[channel] else { emit(["ok": false, "error": "no stream session"]); continue }
            let text = try await m.finish()
            await m.reset()
            emit(["ok": true, "text": text])
        case "diar-start":
            // Open/reset a live streaming diarization session (system channel).
            _ = try await ensureDiarStream()
            emit(["ok": true])
        case "diar-feed":
            // Append the NEW audio; return the current finalized speaker timeline (stable).
            guard let wav = req["wav"] as? String, let d = diarStream else {
                emit(["ok": false, "error": "no diar session"]); continue
            }
            let samples = try converter.resampleAudioFile(path: wav)
            d.addAudio(samples)
            _ = try d.process()
            let segs = d.timeline.speakers.values.flatMap { $0.finalizedSegments }
                .sorted { $0.startTime < $1.startTime }
                .map { ["speaker": $0.speakerIndex, "start": Double($0.startTime), "end": Double($0.endTime)] as [String: Any] }
            emit(["ok": true, "segments": segs])
        case "diar-finish":
            guard let d = diarStream else { emit(["ok": false, "error": "no diar session"]); continue }
            _ = try d.finalizeSession()
            let segs = d.timeline.speakers.values.flatMap { $0.finalizedSegments }
                .sorted { $0.startTime < $1.startTime }
                .map { ["speaker": $0.speakerIndex, "start": Double($0.startTime), "end": Double($0.endTime)] as [String: Any] }
            d.reset()
            emit(["ok": true, "segments": segs])
        case "ping":
            emit(["ok": true, "pong": true])
        default:
            emit(["ok": false, "error": "unknown cmd: \(cmd)"])
        }
    } catch {
        emit(["ok": false, "error": "\(error)"])
    }
}
