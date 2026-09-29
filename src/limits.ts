export const MAX_JSON_BYTES = 1_048_576;
export const MAX_JSON_DEPTH = 64;

export class LimitError extends Error {
  constructor() {
    super('data_limit_exceeded');
    this.name = 'LimitError';
  }
}

export function assertByteLength(value: string | Uint8Array): void {
  const byteLength = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.byteLength;
  if (byteLength > MAX_JSON_BYTES) throw new LimitError();
}

export function assertJsonDepth(value: unknown): void {
  if (value === null || typeof value !== 'object') return;

  type Frame = { value: object; depth: number; exit: boolean };
  const stack: Frame[] = [{ value, depth: 1, exit: false }];
  const ancestors = new WeakSet<object>();

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit) {
      ancestors.delete(frame.value);
      continue;
    }

    if (ancestors.has(frame.value) || frame.depth > MAX_JSON_DEPTH) throw new LimitError();
    ancestors.add(frame.value);
    stack.push({ value: frame.value, depth: frame.depth, exit: true });

    const children = Array.isArray(frame.value)
      ? frame.value
      : Object.values(frame.value);
    for (const child of children) {
      if (child !== null && typeof child === 'object') {
        stack.push({ value: child, depth: frame.depth + 1, exit: false });
      }
    }
  }
}
