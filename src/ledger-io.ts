import path from 'node:path';
import { mkdir, rmdir, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

// Readers take the same lock so rotation cannot move a file between reads.
// Never steal a lock based on age: a paused process may still own it.
export async function withLedgerLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || performance.now() >= deadline) throw error;
      await delay(25);
    }
  }
  try {
    return await action();
  } finally {
    await rmdir(lock);
  }
}
