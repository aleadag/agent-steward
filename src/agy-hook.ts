import type { AgySetupManifest } from './agy-setup.ts';
import { SnapshotSchema } from './contracts.ts';
import { assertByteLength, assertJsonDepth } from './limits.ts';

export type AgyCapture = { requestId: string; observedAt: string; quota: unknown };
export type AgyHookResult = { stdout: string; exitCode: number };
export type AgyHookIO = {
  now: () => Date;
  readManifest: () => Promise<AgySetupManifest | null>;
  captureRequest: { requestId: string; socketPath: string } | null;
  sendCapture: (r: { requestId: string; socketPath: string }, v: AgyCapture) => Promise<void>;
  runRenderer: (c: string, i: string) => Promise<AgyHookResult>;
};
export async function runAgyHook(input: string, io: AgyHookIO): Promise<AgyHookResult> {
  try {
    assertByteLength(input);
  } catch {
    return { stdout: '', exitCode: 1 };
  }
  if (io.captureRequest) {
    try {
      const value = JSON.parse(input);
      assertJsonDepth(value);
      const raw = value?.quota;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const quota: Record<string, Record<string, unknown>> = {};
        for (const key of ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly']) {
          if (!(key in raw)) continue;
          const bucket = raw[key];
          const clean: Record<string, unknown> = {};
          if (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) {
            for (const field of ['remaining_fraction', 'reset_in_seconds']) {
              if (typeof bucket[field] === 'number' && Number.isFinite(bucket[field])) clean[field] = bucket[field];
            }
            const reset = SnapshotSchema.shape.windows.element.shape.reset_at.safeParse(bucket.reset_time);
            if (reset.success) clean.reset_time = reset.data;
          }
          quota[key] = clean;
        }
        await io.sendCapture(io.captureRequest, {
          requestId: io.captureRequest.requestId,
          observedAt: io.now().toISOString(),
          quota,
        });
      }
    } catch {
      /* Capture is optional; the user's renderer still owns its display. */
    }
  }
  try {
    const manifest = await io.readManifest();
    const previous = manifest?.previousStatusLine;
    if (!previous || previous.enabled === false) return { stdout: '', exitCode: 0 };
    return await io.runRenderer(previous.command, input);
  } catch {
    return { stdout: '', exitCode: 1 };
  }
}
