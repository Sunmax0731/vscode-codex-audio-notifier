import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const CONFIG_SECTION = 'codexAudioNotifier';

export type AudioTrigger = 'taskComplete' | 'test';

export class AudioPlayer {
  private readonly extensionUri: vscode.Uri;
  private readonly output: vscode.OutputChannel;
  private lastMissingPath: string | null = null;

  public constructor(extensionUri: vscode.Uri, output: vscode.OutputChannel) {
    this.extensionUri = extensionUri;
    this.output = output;
  }

  public async play(trigger: AudioTrigger): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const enabled = configuration.get<boolean>('enabled', true);
    if (!enabled && trigger !== 'test') {
      return;
    }

    const soundPath = this.resolveSoundPath(configuration.get<string | null>('customSoundPath', null));
    if (!soundPath) {
      if (trigger === 'test') {
        void vscode.window.showErrorMessage('Codex Audio Notifier: no sound file could be resolved.');
      }
      return;
    }

    try {
      await fs.access(soundPath);
    } catch {
      this.warnMissingFile(soundPath);
      if (trigger === 'test') {
        void vscode.window.showErrorMessage(`Codex Audio Notifier: sound file was not found: ${soundPath}`);
      }
      return;
    }

    try {
      await launchAudioPlayback(soundPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Playback failed: ${message}`);
      if (trigger === 'test') {
        void vscode.window.showErrorMessage(`Codex Audio Notifier: playback failed: ${message}`);
      }
      return;
    }

    if (trigger === 'test') {
      void vscode.window.showInformationMessage('Codex Audio Notifier: played the configured sound.');
    }
  }

  private resolveSoundPath(customPath: string | null): string | null {
    const trimmed = customPath?.trim() ?? '';
    if (trimmed.length > 0) {
      if (path.isAbsolute(trimmed)) {
        return trimmed;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        return path.resolve(workspaceFolder.uri.fsPath, trimmed);
      }

      return null;
    }

    return vscode.Uri.joinPath(this.extensionUri, 'media', 'default-notification.mp3').fsPath;
  }

  private warnMissingFile(soundPath: string): void {
    if (this.lastMissingPath === soundPath) {
      return;
    }

    this.lastMissingPath = soundPath;
    this.log(`Sound file was not found: ${soundPath}`);
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

async function launchAudioPlayback(soundPath: string): Promise<void> {
  switch (process.platform) {
    case 'win32':
      await playOnWindows(soundPath);
      return;
    case 'darwin':
      await spawnDetached('afplay', [soundPath]);
      return;
    default:
      await playOnLinux(soundPath);
      return;
  }
}

async function playOnWindows(soundPath: string): Promise<void> {
  const escapedPath = soundPath.replace(/'/g, "''");
  const script = [
    `$path = '${escapedPath}'`,
    '$player = New-Object -ComObject WMPlayer.OCX.7',
    '$player.settings.volume = 100',
    '$player.URL = $path',
    '$player.controls.play()',
    '$deadline = (Get-Date).AddMinutes(5)',
    'while ((Get-Date) -lt $deadline) {',
    '  if ($player.playState -eq 1) { break }',
    '  Start-Sleep -Milliseconds 200',
    '}',
    '$player.close()',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await spawnDetached('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
}

async function playOnLinux(soundPath: string): Promise<void> {
  const candidates: Array<{ command: string; args: string[] }> = [
    { command: 'paplay', args: [soundPath] },
    { command: 'ffplay', args: ['-nodisp', '-autoexit', soundPath] },
    { command: 'mpg123', args: [soundPath] },
    { command: 'play', args: [soundPath] },
  ];

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      await spawnDetached(candidate.command, candidate.args);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if ((lastError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error('No supported audio player was found on this system.');
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
