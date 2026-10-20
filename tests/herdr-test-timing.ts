import { constants, writeSync } from 'node:fs';
import { lstat, open, mkdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import type { LeaseIO } from '../src/herdr-adapter/lease.ts';

const cases = ['legacy', 'capacity', 'saturation', 'approval', 'diagnostics', 'shutdown', 'shutdown-child'] as const;
const phases = [
  'setup',
  'admission',
  'slot',
  'assessment',
  'run',
  'pause',
  'resume',
  'cleanup',
  'writers',
  'release',
  'stop',
  'settled',
] as const;
const handleMethods = ['stat', 'chmod', 'read', 'writeFile', 'sync', 'close'] as const;
type Operation = 'lstat' | 'open' | 'mkdir' | 'rename' | 'unlink' | (typeof handleMethods)[number];
export type TimingCase = (typeof cases)[number];
export type TimingPhase = (typeof phases)[number];
export type TestTiming = {
  phase: (phase: TimingPhase, index?: number) => void;
  io: (overrides?: Partial<LeaseIO>) => Partial<LeaseIO>;
};
type Metric = {
  count: number;
  pending: number;
  errors: number;
  exclusive_exists: number;
  total_ms: number;
  max_ms: number;
};

// Test-only diagnostics: never serialize IO arguments, return values or errors.
// IO coverage is the injected metadata calls below plus the named handle methods,
// not every filesystem call made by the process. All metrics are cumulative.
export async function withTestTiming<T>(
  name: TimingCase,
  action: (timing: TestTiming) => Promise<T>,
  options: { enabled?: boolean; write?: (line: string) => void; worker?: number; now?: () => number } = {},
): Promise<T> {
  if (!(options.enabled ?? process.env.AGENT_STEWARD_TEST_TIMING === '1'))
    return action({ phase: () => {}, io: (overrides = {}) => overrides });
  if (!cases.includes(name)) throw new Error('invalid timing case');
  const worker = options.worker ?? 0;
  if (!Number.isInteger(worker) || worker < 0 || worker > 8) throw new Error('invalid timing worker');
  const write =
    options.write ??
    ((line: string) => {
      if (process.env.AGENT_STEWARD_TEST_TIMING_FD === '3') writeSync(3, line);
      else process.stdout.write(line);
    });
  const clock = options.now ?? (() => performance.now());
  const milliseconds = (value: number) => Math.round(value * 1000) / 1000;
  const started = clock();
  let phase: TimingPhase = 'setup',
    index = 0,
    phaseStarted = started,
    nextTick = started + 100;
  let lag = 0,
    lastSample = started,
    lines = 0;
  const io: Partial<Record<Operation, Metric>> = {};
  const emit = (event: 'phase' | 'sample' | 'finished' | 'failed') => {
    const now = clock();
    lag = Math.max(lag, now - nextTick, 0);
    if (lines >= (event === 'finished' || event === 'failed' ? 64 : 63)) return;
    lines++;
    try {
      write(
        `STEWARD_TEST_TIMING ${JSON.stringify({
          case: name,
          worker,
          phase,
          index,
          event,
          elapsed_ms: Math.round(now - started),
          phase_ms: Math.round(now - phaseStarted),
          loop_lag_ms: Math.round(lag),
          io: Object.fromEntries(
            Object.entries(io).map(([operation, metric]) => [
              operation,
              {
                ...metric,
                total_ms: milliseconds(metric.total_ms),
                max_ms: milliseconds(metric.max_ms),
              },
            ]),
          ),
        })}\n`,
      );
    } catch {
      // Instrumentation cannot replace a test result or its original rejection.
    }
  };
  const measure = async <V>(operation: Operation, call: () => Promise<V>, exclusive = false): Promise<V> => {
    const metric = (io[operation] ??= { count: 0, pending: 0, errors: 0, exclusive_exists: 0, total_ms: 0, max_ms: 0 });
    metric.count++;
    metric.pending++;
    const before = clock();
    try {
      return await call();
    } catch (error) {
      metric.errors++;
      if (exclusive && (error as NodeJS.ErrnoException)?.code === 'EEXIST') metric.exclusive_exists++;
      throw error;
    } finally {
      metric.pending--;
      const elapsed = clock() - before;
      metric.total_ms += elapsed;
      metric.max_ms = Math.max(metric.max_ms, elapsed);
    }
  };
  const handle = (original: FileHandle): FileHandle =>
    new Proxy(original, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (handleMethods.includes(key as (typeof handleMethods)[number]))
          return (...args: unknown[]) => measure(key as Operation, async () => Reflect.apply(value, target, args));
        return value.bind(target);
      },
    });
  const timing: TestTiming = {
    phase(next, item = 0) {
      if (!phases.includes(next)) throw new Error('invalid timing phase');
      if (!Number.isInteger(item) || item < 0 || item > 8) throw new Error('invalid timing index');
      phase = next;
      index = item;
      phaseStarted = clock();
      emit('phase');
    },
    io(overrides = {}) {
      const native = {
        lstat,
        open,
        mkdir: async (path: string, mode: { mode: number }) => {
          await mkdir(path, mode);
        },
        rename,
        unlink,
        ...overrides,
      };
      return {
        ...overrides,
        lstat: (path) => measure('lstat', () => native.lstat(path)),
        open: async (path, flags, mode) =>
          handle(await measure('open', () => native.open(path, flags, mode), Boolean(flags & constants.O_EXCL))),
        mkdir: (path, mode) => measure('mkdir', () => native.mkdir(path, mode)),
        rename: (from, to) => measure('rename', () => native.rename(from, to)),
        unlink: (path) => measure('unlink', () => native.unlink(path)),
      };
    },
  };
  const timer = setInterval(() => {
    const now = clock();
    lag = Math.max(lag, now - nextTick, 0);
    nextTick = now + 100;
    if (now - lastSample >= 2000) {
      emit('sample');
      lastSample = now;
    }
  }, 100);
  timer.unref();
  emit('phase');
  try {
    const result = await action(timing);
    emit('finished');
    return result;
  } catch (error) {
    emit('failed');
    throw error;
  } finally {
    clearInterval(timer);
  }
}
