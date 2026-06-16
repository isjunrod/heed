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

let diarizer = DiarizerManager(config: DiarizerConfig())
let diarModels = try await DiarizerModels.downloadIfNeeded()
diarizer.initialize(models: diarModels)

let converter = AudioConverter()
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
            emit(["ok": true, "speakers": speakers, "segments": segs])
        case "ping":
            emit(["ok": true, "pong": true])
        default:
            emit(["ok": false, "error": "unknown cmd: \(cmd)"])
        }
    } catch {
        emit(["ok": false, "error": "\(error)"])
    }
}
