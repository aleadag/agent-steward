import { closeSync, constants, openSync, writeFileSync } from 'node:fs';

export async function writeFifoWithDeadline(
  fifo: string,
  contents: string,
  readerIsAlive: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (!readerIsAlive()) throw new Error('adapter exited before config FIFO reader opened');
    if (Date.now() >= deadline) throw new Error('timed out waiting for config FIFO reader');

    let fd: number;
    try {
      fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENXIO') throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for config FIFO reader');
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
      continue;
    }

    try {
      if (!readerIsAlive()) throw new Error('adapter exited before config FIFO write');
      writeFileSync(fd, contents);
    } finally {
      closeSync(fd);
    }
    return;
  }
}
