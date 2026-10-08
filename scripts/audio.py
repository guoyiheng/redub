"""Local VAD and transcription. No media leaves the machine."""
import json
import os
import sys
from pathlib import Path


def setup_windows_dll_directories():
    if sys.platform != "win32":
        return
    import site

    search_dirs = []
    try:
        search_dirs.extend(site.getsitepackages())
    except Exception:
        pass
    try:
        search_dirs.append(site.getusersitepackages())
    except Exception:
        pass

    for base in search_dirs:
        nvidia_path = Path(base) / "nvidia"
        if nvidia_path.is_dir():
            for bin_dir in nvidia_path.glob("*/bin"):
                if bin_dir.is_dir():
                    try:
                        os.add_dll_directory(str(bin_dir))
                    except Exception:
                        pass


def get_whisper_model(model_name="small", preferred_device=None):
    from faster_whisper import WhisperModel

    setup_windows_dll_directories()

    target_device = preferred_device or os.environ.get("REDUB_DEVICE")
    if target_device not in ("cuda", "cpu"):
        target_device = "cpu"
        try:
            import torch

            if torch.cuda.is_available():
                target_device = "cuda"
        except Exception:
            try:
                import ctranslate2

                if ctranslate2.get_cuda_device_count() > 0:
                    target_device = "cuda"
            except Exception:
                target_device = "cpu"

    if target_device == "cuda":
        try:
            return WhisperModel(model_name, device="cuda", compute_type="float16")
        except Exception as e:
            sys.stderr.write(f"CUDA whisper initialization failed ({e}), falling back to CPU.\n")

    return WhisperModel(model_name, device="cpu", compute_type="int8")


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
        model = get_whisper_model(data.get("model", "small"), preferred_device=data.get("device"))
        result = transcribe_segments(model, data["segments"], data.get("language"))
    else:
        raise ValueError("Unknown action")
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
