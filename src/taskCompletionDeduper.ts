import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type TaskCompletionNotificationKind = 'audio' | 'toast';

const CLAIM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export class TaskCompletionDeduper {
  private readonly claimsRoot: string;
  private cleanupPromise: Promise<void> | null = null;
  private lastCleanupStartedAt = 0;

  public constructor(private readonly log: (message: string) => void) {
    this.claimsRoot = path.join(
      os.homedir(),
      '.codex',
      'vscode-codex-audio-notifier',
      'task-completion-claims',
    );
  }

  public async claim(filePath: string, eventKey: string, kind: TaskCompletionNotificationKind): Promise<boolean> {
    await fsp.mkdir(this.claimsRoot, { recursive: true });
    this.startCleanupIfNeeded();

    const resolvedFilePath = path.resolve(filePath);
    const claimPath = path.join(this.claimsRoot, `${kind}-${buildClaimHash(resolvedFilePath, eventKey)}.json`);
    const claimPayload = JSON.stringify({
      kind,
      filePath: resolvedFilePath,
      eventKey,
      claimedAt: new Date().toISOString(),
    });

    try {
      await fsp.writeFile(claimPath, claimPayload, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  }

  private startCleanupIfNeeded(): void {
    const now = Date.now();
    if (this.cleanupPromise || now - this.lastCleanupStartedAt < CLEANUP_INTERVAL_MS) {
      return;
    }

    this.lastCleanupStartedAt = now;
    this.cleanupPromise = this.cleanupExpiredClaims()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Task completion dedupe cleanup failed: ${message}`);
      })
      .finally(() => {
        this.cleanupPromise = null;
      });
  }

  private async cleanupExpiredClaims(): Promise<void> {
    let entries: Array<{ isFile(): boolean; name: string }>;
    try {
      entries = await fsp.readdir(this.claimsRoot, { withFileTypes: true });
    } catch {
      return;
    }

    const cutoffTimeMs = Date.now() - CLAIM_RETENTION_MS;
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const claimPath = path.join(this.claimsRoot, entry.name);
          try {
            const stat = await fsp.stat(claimPath);
            if (stat.mtimeMs >= cutoffTimeMs) {
              return;
            }

            await fsp.unlink(claimPath);
          } catch {
            // Another VS Code window may delete the file first.
          }
        }),
    );
  }
}

function buildClaimHash(filePath: string, eventKey: string): string {
  return crypto.createHash('sha256').update(`${filePath}\n${eventKey}`).digest('hex');
}
