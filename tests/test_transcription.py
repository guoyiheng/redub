"""Transcript normalization tests; no model downloads or audio processing required."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from scripts.audio import transcribe_segments


def transcript(text, language):
    return iter([SimpleNamespace(text=text)]), SimpleNamespace(language=language)


class TranscriptionTests(unittest.TestCase):
    def test_selected_chinese_is_simplified_and_has_a_chinese_prompt(self):
        model = Mock()
        model.transcribe.return_value = transcript(" 這個聲音來自電影，請聽聽這段對話。 ", "zh")

        result = transcribe_segments(model, [{"id": "line-1", "audio": "zh.wav"}], "zh")

        self.assertEqual(result, [{"id": "line-1", "text": "这个声音来自电影，请听听这段对话。"}])
        self.assertEqual(model.transcribe.call_args.kwargs["language"], "zh")
        self.assertIn("简体中文", model.transcribe.call_args.kwargs["initial_prompt"])

    def test_auto_detection_simplifies_only_chinese_in_a_mixed_project(self):
        model = Mock()
        model.transcribe.side_effect = [
            transcript("這是臺灣的電影。", "zh"),
            transcript(" This is the original dialogue. ", "en"),
            transcript("図書館で本を読む。", "ja"),
        ]
        segments = [{"id": language, "audio": f"{language}.wav"} for language in ["zh", "en", "ja"]]

        result = transcribe_segments(model, segments)

        self.assertEqual(result, [
            {"id": "zh", "text": "这是台湾的电影。"},
            {"id": "en", "text": "This is the original dialogue."},
            {"id": "ja", "text": "図書館で本を読む。"},
        ])
        for call in model.transcribe.call_args_list:
            self.assertIsNone(call.kwargs["language"])
            self.assertNotIn("initial_prompt", call.kwargs)

    def test_selected_foreign_language_is_not_changed(self):
        model = Mock()
        model.transcribe.return_value = transcript("図書館で本を読む。", "ja")

        result = transcribe_segments(model, [{"id": "japanese", "audio": "ja.wav"}], "ja")

        self.assertEqual(result[0]["text"], "図書館で本を読む。")
        self.assertEqual(model.transcribe.call_args.kwargs["language"], "ja")
        self.assertNotIn("initial_prompt", model.transcribe.call_args.kwargs)

    def test_auto_language_value_keeps_detection_enabled(self):
        model = Mock()
        model.transcribe.return_value = transcript("這句話保持原來的語氣。", "zh")

        result = transcribe_segments(model, [{"id": "auto", "audio": "auto.wav"}], "auto")

        self.assertIsNone(model.transcribe.call_args.kwargs["language"])
        self.assertEqual(result[0]["text"], "这句话保持原来的语气。")


if __name__ == "__main__":
    unittest.main()
