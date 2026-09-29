import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { LimitError, MAX_JSON_BYTES } from './limits.js';

export function readBoundedUtf8(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let ended = false;
    let settled = false;

    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('aborted', onAborted);
      stream.removeListener('close', onClose);
    };
    const fail = (error: unknown, destroy: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy && !stream.destroyed) stream.destroy();
      reject(error);
    };
    const onData = (chunk: Buffer | Uint8Array | string): void => {
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
        fail(new TypeError('invalid_stream_chunk'), true);
        return;
      }
      const chunkLength = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
      if (byteLength + chunkLength > MAX_JSON_BYTES) {
        fail(new LimitError(), true);
        return;
      }
      byteLength += chunkLength;
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
    };
    const onEnd = (): void => {
      ended = true;
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, byteLength)));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error): void => fail(error, false);
    const onAborted = (): void => fail(new Error('stream_aborted'), true);
    const onClose = (): void => {
      if (!ended) fail(new Error('stream_closed'), false);
    };

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('aborted', onAborted);
    stream.once('close', onClose);
  });
}

export async function readFileText(path: string): Promise<string> {
  return readBoundedUtf8(createReadStream(path));
}
