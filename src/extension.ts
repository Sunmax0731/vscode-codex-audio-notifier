import * as vscode from 'vscode';
import { AudioPlayer } from './audioPlayer';
import { CodexSessionMonitor } from './sessionMonitor';

const CONFIG_SECTION = 'codexAudioNotifier';
const TEST_SOUND_COMMAND = 'codexAudioNotifier.testSound';
const ENABLE_TERMINAL_BELL_COMMAND = 'codexAudioNotifier.enableTerminalBellSignal';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Codex Audio Notifier');
  const audioPlayer = new AudioPlayer(context.extensionUri, output);
  const monitor = new CodexSessionMonitor(output, audioPlayer);

  context.subscriptions.push(
    output,
    monitor,
    vscode.commands.registerCommand(TEST_SOUND_COMMAND, async () => {
      await audioPlayer.play('test');
    }),
    vscode.commands.registerCommand(ENABLE_TERMINAL_BELL_COMMAND, async () => {
      await ensureTerminalBellSignalSetting(output, true);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }

      if (event.affectsConfiguration(`${CONFIG_SECTION}.forceTerminalBellSignalOn`)) {
        void ensureTerminalBellSignalSetting(output, false);
      }

      monitor.refreshConfiguration();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      monitor.refreshConfiguration();
    }),
  );

  void ensureTerminalBellSignalSetting(output, false);
  void monitor.start();
}

export function deactivate(): void {
  // VS Code disposes subscriptions automatically.
}

async function ensureTerminalBellSignalSetting(
  output: vscode.OutputChannel,
  showConfirmation: boolean,
): Promise<void> {
  const extensionConfiguration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const shouldForce = extensionConfiguration.get<boolean>('forceTerminalBellSignalOn', true);
  if (!shouldForce && !showConfirmation) {
    return;
  }

  const accessibilityConfiguration = vscode.workspace.getConfiguration('accessibility.signals');
  const currentValue = accessibilityConfiguration.get<string>('terminalBell');
  if (currentValue === 'on') {
    if (showConfirmation) {
      void vscode.window.showInformationMessage(
        'Codex Audio Notifier: accessibility.signals.terminalBell is already set to on.',
      );
    }
    return;
  }

  try {
    await accessibilityConfiguration.update('terminalBell', 'on', vscode.ConfigurationTarget.Global);
    output.appendLine(`[${new Date().toISOString()}] Set accessibility.signals.terminalBell to on.`);
    if (showConfirmation) {
      void vscode.window.showInformationMessage(
        'Codex Audio Notifier: set accessibility.signals.terminalBell to on.',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(
      `[${new Date().toISOString()}] Failed to update accessibility.signals.terminalBell: ${message}`,
    );
    if (showConfirmation) {
      void vscode.window.showErrorMessage(
        `Codex Audio Notifier: could not update accessibility.signals.terminalBell: ${message}`,
      );
    }
  }
}
