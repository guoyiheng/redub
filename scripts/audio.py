"""Local VAD and transcription. No media leaves the machine."""
import json
import sys
from pathlib import Path


def transcribe_segments(model, segments, language=None):
    language = None if language == "auto" else language
    options = {
        "language": language or None,
        "beam_size": 5,
        "condition_on_previous_text": False,
    }
    # A Chinese prompt is only appropriate when the user selected Chinese.
    # Automatic detection must remain free to recognize the original language.
    if language == "zh":
        options["initial_prompt"] = "请使用简体中文记录台词。"

    converter = None
    result = []
    for item in segments:
        spans, info = model.transcribe(item["audio"], **options)
        text = "".join(span.text for span in spans).strip()
        if language == "zh" or (not language and info.language == "zh"):
            if converter is None:
                from opencc import OpenCC
                converter = OpenCC("t2s")
            text = converter.convert(text)
        result.append({"id": item["id"], "text": text})
    return result


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
        result = transcribe_segments(model, data["segments"], data.get("language"))
    else:
        raise ValueError("Unknown action")
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
