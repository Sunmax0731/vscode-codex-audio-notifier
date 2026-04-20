# Codex Audio Notifier

VS Code extension that plays a sound and shows a toast notification when the Codex VS Code extension finishes a task.

## How it works

The extension watches `~/.codex/sessions/**/*.jsonl` and looks for the Codex session event:

- `event_msg.payload.type == "task_complete"`

Only sessions with `source: "vscode"` are considered.
By default, the extension further limits notifications to sessions whose `cwd` matches the current VS Code window.

## Settings

- `codexAudioNotifier.enabled`
  Enable or disable playback.
- `codexAudioNotifier.customSoundPath`
  Override the bundled default sound.
  You can use an absolute path such as `D:\Sounds\my-notify.mp3`.
  If you provide a relative path, it is resolved from the first workspace folder in the current window.
- `codexAudioNotifier.watchAllVsCodeSessions`
  If `true`, notifies for any Codex VS Code session on this machine.
  If `false`, only the current window's workspace is used.
- `codexAudioNotifier.showToastNotification`
  Enable or disable the VS Code toast shown when Codex finishes a task.
- `codexAudioNotifier.forceTerminalBellSignalOn`
  When enabled, the extension sets `accessibility.signals.terminalBell` to `on` at startup.

## Command

- `Codex Audio Notifier: Test Sound`
- `Codex Audio Notifier: Set Terminal Bell Signal to On`

Use this command after changing `customSoundPath` to confirm that playback works.
Toast notifications appear on real `task_complete` events and include a `Show Log` action that opens the extension output channel.

## Development

```bash
npm install
npm run build
```

Then press `F5` in VS Code to launch an Extension Development Host.
