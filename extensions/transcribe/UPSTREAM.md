# pi-transcribe

> Vendored from [earendil-works/pi-transcribe](https://github.com/earendil-works/pi-transcribe) at commit `45924bd491e5ee2655d4269aa504eab11e27a424` (2026-08-13). The original MIT license is preserved in `LICENSE`.

Local speech-to-text dictation for Pi.

## Install

This copy is bundled with the parent `pi-extensions` package and is loaded automatically.

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Alt+Z` by default) to start and stop recording;
- `/transcribe` for model, transcription-language, microphone, and shortcut settings.

Press the shortcut while Pi has focus, speak, then press it again. A live level meter appears above the editor while recording. `Esc` cancels. Audio is transcribed locally and inserted at the editor cursor. The shortcut is a Pi terminal binding, not a global OS hotkey.
