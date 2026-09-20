"""Local VAD and transcription. No media leaves the machine."""
import json
import sys
from pathlib import Path


def main():
    action, input_path, output_path = sys.argv[1:]
    data = json.loads(Path(input_path).read_text())
    from faster_whisper.audio import decode_audio

    if action == "segment":
        from faster_whisper.vad import VadOptions, get_speech_timestamps
        audio = decode_audio(data["audio"], sampling_rate=16000)
        spans = get_speech_timestamps(audio, VadOptions(
            min_speech_duration_ms=180, min_silence_duration_ms=350,
            speech_pad_ms=100, max_speech_duration_s=25,
        ))
        result = [{"start": item["start"] / 16000, "end": item["end"] / 16000} for item in spans]
    elif action == "transcribe":
        from faster_whisper import WhisperModel
        model = WhisperModel(data.get("model", "small"), device="cpu", compute_type="int8")
        result = []
        for item in data["segments"]:
            spans, _ = model.transcribe(item["audio"], language=data.get("language") or None,
                                        beam_size=5, condition_on_previous_text=False)
            result.append({"id": item["id"], "text": "".join(s.text for s in spans).strip()})
    else:
        raise ValueError("Unknown action")
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
