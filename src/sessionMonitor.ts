import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AudioPlayer } from './audioPlayer';

interface SessionMeta {
  readonly cwd: string | null;
  readonly source: string | null;
}

interface SessionState {
  offset: number;
  bufferedText: string;
  meta: SessionMeta | null;
  eligible: boolean;
}

const CONFIG_SECTION = 'codexAudioNotifier';
const FULL_RESCAN_INTERVAL_MS = 30000;
const META_READ_LIMIT_BYTES = 2 * 1024 * 1024;
const META_READ_CHUNK_BYTES = 64 * 1024;

export class CodexSessionMonitor implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private readonly audioPlayer: AudioPlayer;
  private readonly sessionsRoot: string;
  private readonly activationTimeMs: number;
  private readonly states = new Map<string, SessionState>();
  private readonly activeReads = new Set<string>();
  private watcher: fs.FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private started = false;

  public constructor(output: vscode.OutputChannel, audioPlayer: AudioPlayer) {
    this.output = output;
    this.audioPlayer = audioPlayer;
    this.sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
    this.activationTimeMs = Date.now();
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    try {
      await fsp.access(this.sessionsRoot);
    } catch {
      this.log(`Sessions directory was not found: ${this.sessionsRoot}`);
      return;
    }

    await this.initialScan();
    this.refreshConfiguration();
    this.startWatcher();
    this.rescanTimer = setInterval(() => {
      void this.rescan();
    }, FULL_RESCAN_INTERVAL_MS);
  }

  public refreshConfiguration(): void {
    for (const [filePath, state] of this.states) {
      state.eligible = this.isEligible(state.meta);
      this.log(`Tracking ${filePath} (${state.eligible ? 'eligible' : 'ignored'})`);
    }
  }

  public dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
  }

  private async initialScan(): Promise<void> {
    const sessionFiles = await this.listSessionFiles();
    for (const filePath of sessionFiles) {
      await this.ensureTracked(filePath);
    }
    this.log(`Initial scan completed. Found ${sessionFiles.length} session file(s).`);
  }

  private startWatcher(): void {
    try {
      this.watcher = fs.watch(this.sessionsRoot, { recursive: process.platform !== 'linux' }, (_eventType, filename) => {
        if (!filename) {
          return;
        }

        const candidatePath = path.join(this.sessionsRoot, filename.toString());
        if (!candidatePath.endsWith('.jsonl')) {
          return;
        }

        void this.onFileChanged(candidatePath);
      });
      this.log(`Watching ${this.sessionsRoot}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`File watcher could not be started: ${message}`);
    }
  }

  private async rescan(): Promise<void> {
    const sessionFiles = await this.listSessionFiles();
    const known = new Set(this.states.keys());
    for (const filePath of sessionFiles) {
      known.delete(filePath);
      await this.ensureTracked(filePath);
      await this.readAppendedContent(filePath);
    }

    for (const removed of known) {
      this.states.delete(removed);
    }
  }

  private async onFileChanged(filePath: string): Promise<void> {
    await this.ensureTracked(filePath);
    await this.readAppendedContent(filePath);
  }

  private async ensureTracked(filePath: string): Promise<void> {
    if (this.states.has(filePath)) {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return;
    }

    if (!stat.isFile()) {
      return;
    }

    const meta = await this.readSessionMeta(filePath);
    const startAtEnd = stat.birthtimeMs <= this.activationTimeMs;
    const state: SessionState = {
      offset: startAtEnd ? stat.size : 0,
      bufferedText: '',
      meta,
      eligible: this.isEligible(meta),
    };
    this.states.set(filePath, state);
  }

  private async readAppendedContent(filePath: string): Promise<void> {
    const state = this.states.get(filePath);
    if (!state || this.activeReads.has(filePath)) {
      return;
    }

    this.activeReads.add(filePath);
    try {
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        this.states.delete(filePath);
        return;
      }

      if (!stat.isFile()) {
        this.states.delete(filePath);
        return;
      }

      if (stat.size < state.offset) {
        state.offset = 0;
        state.bufferedText = '';
      }

      if (stat.size === state.offset) {
        return;
      }

      const byteCount = stat.size - state.offset;
      const buffer = Buffer.alloc(byteCount);
      const handle = await fsp.open(filePath, 'r');
      try {
        const { bytesRead } = await handle.read(buffer, 0, byteCount, state.offset);
        state.offset += bytesRead;
        const text = state.bufferedText + buffer.subarray(0, bytesRead).toString('utf8');
        const lines = text.split(/\r?\n/);
        state.bufferedText = lines.pop() ?? '';
        for (const line of lines) {
          this.processLine(filePath, state, line);
        }
      } finally {
        await handle.close();
      }
    } finally {
      this.activeReads.delete(filePath);
    }
  }

  private processLine(filePath: string, state: SessionState, line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const item = parsed as { type?: string; payload?: { type?: string; cwd?: string; source?: string; turn_id?: string } };
    if (!state.meta && item.type === 'session_meta') {
      state.meta = {
        cwd: typeof item.payload?.cwd === 'string' ? item.payload.cwd : null,
        source: typeof item.payload?.source === 'string' ? item.payload.source : null,
      };
      state.eligible = this.isEligible(state.meta);
    }

    if (!state.eligible) {
      return;
    }

    if (item.type === 'event_msg' && item.payload?.type === 'task_complete') {
      const turnId = typeof item.payload.turn_id === 'string' ? item.payload.turn_id : 'unknown-turn';
      this.log(`Detected Codex task completion in ${filePath} (${turnId})`);
      void this.showTaskCompleteToast(state.meta);
      void this.audioPlayer.play('taskComplete');
    }
  }

  private async showTaskCompleteToast(meta: SessionMeta | null): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const enabled = configuration.get<boolean>('showToastNotification', true);
    if (!enabled) {
      return;
    }

    const message = buildToastMessage(meta);
    const action = 'Show Log';
    const selection = await vscode.window.showInformationMessage(message, action);
    if (selection === action) {
      this.output.show(true);
    }
  }

  private isEligible(meta: SessionMeta | null): boolean {
    if (!meta || meta.source !== 'vscode' || !meta.cwd) {
      return false;
    }

    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const watchAll = configuration.get<boolean>('watchAllVsCodeSessions', false);
    if (watchAll) {
      return true;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return true;
    }

    return workspaceFolders.some((folder) => isSameOrDescendant(meta.cwd as string, folder.uri.fsPath));
  }

  private async readSessionMeta(filePath: string): Promise<SessionMeta | null> {
    const handle = await fsp.open(filePath, 'r');
    try {
      let totalBytes = 0;
      let aggregated = '';
      while (totalBytes < META_READ_LIMIT_BYTES) {
        const remaining = META_READ_LIMIT_BYTES - totalBytes;
        const chunkSize = Math.min(META_READ_CHUNK_BYTES, remaining);
        const buffer = Buffer.alloc(chunkSize);
        const { bytesRead } = await handle.read(buffer, 0, chunkSize, totalBytes);
        if (bytesRead === 0) {
          break;
        }

        totalBytes += bytesRead;
        aggregated += buffer.subarray(0, bytesRead).toString('utf8');
        const newlineIndex = aggregated.indexOf('\n');
        if (newlineIndex < 0) {
          continue;
        }

        const firstLine = aggregated.slice(0, newlineIndex).trim();
        if (firstLine.length === 0) {
          return null;
        }

        const parsed = JSON.parse(firstLine) as { type?: string; payload?: { cwd?: string; source?: string } };
        if (parsed.type !== 'session_meta') {
          return null;
        }

        return {
          cwd: typeof parsed.payload?.cwd === 'string' ? parsed.payload.cwd : null,
          source: typeof parsed.payload?.source === 'string' ? parsed.payload.source : null,
        };
      }
    } catch {
      return null;
    } finally {
      await handle.close();
    }

    return null;
  }

  private async listSessionFiles(): Promise<string[]> {
    const result: string[] = [];
    const queue: string[] = [this.sessionsRoot];
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) {
        continue;
      }

      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const resolved = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(resolved);
          continue;
        }
        if (entry.isFile() && resolved.endsWith('.jsonl')) {
          result.push(resolved);
        }
      }
    }
    return result;
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

function isSameOrDescendant(candidatePath: string, rootPath: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidatePath);
  const normalizedRoot = normalizeForComparison(rootPath);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function buildToastMessage(meta: SessionMeta | null): string {
  const cwd = meta?.cwd?.trim();
  if (!cwd) {
    return 'Codex finished a task.';
  }

  const folderName = path.basename(cwd);
  if (!folderName) {
    return 'Codex finished a task.';
  }

  return `Codex finished a task in ${folderName}.`;
}
