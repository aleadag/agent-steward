import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appendDiagnostic, type DiagnosticEvent } from './diagnostics.ts';
import { EpisodeStore, parseEpisode, type Episode } from './state.ts';
import { assertNoCredentials, configuredApiKeys } from '../privacy.ts';
import type { LeaseAttempt, SchedulerLeaseStore } from './lease.ts';
import {
  validateWorkflowScope,
  workflowSession,
  type AdmissionTicket,
  type WorkflowBinding,
  type RuntimePermission,
  type WorkflowResult,
  type WorkflowScope,
  type WorkflowState,
} from './workflow-state.ts';

type EffectProof = {
  valid(): Promise<boolean>;
  reserve(action: (assertGuard: () => Promise<void>) => Promise<boolean>): Promise<boolean | null>;
};
export type WorkflowAuthority = {
  readonly scope: WorkflowScope;
  readonly paneId: string;
  readonly workspaceId: string;
  readonly permission: Readonly<RuntimePermission>;
  readonly ticket: AdmissionTicket;
  readonly generation: string;
  readonly ownsGeneration: boolean;
  readonly signal: AbortSignal;
  admissionOpen(): boolean;
  valid(): Promise<boolean>;
  dispatch(kind: 'approval' | 'recovery', effect: () => Promise<void>, proof?: EffectProof): Promise<void>;
};
export type WorkflowAttempt = {
  readonly ready: Promise<WorkflowAuthority | null>;
  readonly signal: AbortSignal;
  close(): void;
  finish(): Promise<WorkflowResult>;
};
export type AuthorityOptions = {
  state: WorkflowState;
  scope: WorkflowScope;
  paneId: string;
  workspaceId: string;
  permission: () => Promise<RuntimePermission | null>;
  signal: AbortSignal;
  heartbeatIntervalMs?: number;
  scheduleHeartbeat?: (tick: () => void) => () => void;
  shutdownDeadline?: (ms: number, expire: () => void) => () => void;
  diagnose?: (event: DiagnosticEvent) => Promise<void>;
};
export type JobSlot = {
  readonly signal: AbortSignal;
  valid(): Promise<boolean>;
  // Caller holds pane -> retry-session locks. Only this admitted writer may
  // advance the captured history proof, including uncertainty before input.
  record(episode: Episode): Promise<void>;
  dispatch(effect: () => Promise<void>): Promise<void>;
};
export type JobSlotAttempt = {
  readonly ready: Promise<JobSlot | null>;
  readonly duplicate: boolean;
  close(): void;
  finish(): Promise<WorkflowResult>;
};
const deadline = (ms: number, expire: () => void): (() => void) => {
  const timer = setTimeout(expire, ms);
  return () => clearTimeout(timer);
};

// Every started handle is retained before its first publication await. Refused
// handles never release the selected owner; pending handles revoke independently.
class OwnedHandle {
  private refused = false;
  private readonly settled: Promise<string | null>;
  constructor(readonly attempt: LeaseAttempt) {
    this.settled = attempt.ready.then((token) => {
      this.refused = token === null;
      return token;
    });
    void this.settled.catch(() => {});
  }
  async stop(): Promise<boolean> {
    this.attempt.close();
    if (this.refused) return true;
    try {
      await this.attempt.release();
      return true;
    } catch {
      // A settled protocol refusal proves that this token never held authority.
      try {
        return (await this.settled) === null;
      } catch {
        return false;
      }
    }
  }
}

class Lifetime {
  readonly controller = new AbortController();
  private result: WorkflowResult = 'stopped';
  private completion: Promise<WorkflowResult> | undefined;
  private closing = false;
  readonly stoppers = new Set<() => Promise<boolean>>();
  constructor(private readonly shutdown: AuthorityOptions['shutdownDeadline']) {}
  open(): boolean {
    return !this.closing;
  }
  close(result: WorkflowResult = 'stopped'): void {
    if (!this.open()) return;
    this.closing = true;
    this.result = result;
    let resolveCompletion!: (result: WorkflowResult) => void;
    this.completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    // Start the parent's budget at shutdown entry, before child abort listeners.
    {
      const resolve = resolveCompletion;
      let settled = false;
      let cancel = () => {};
      const finish = (value: WorkflowResult) => {
        if (settled) return;
        settled = true;
        cancel();
        resolve(value);
      };
      try {
        cancel = (this.shutdown ?? deadline)(5000, () => finish('shutdown_incomplete'));
        if (settled) cancel();
      } catch {
        finish('shutdown_incomplete');
      }
      // Closing is synchronous and monotonic, before any publication await.
      this.controller.abort();
      const confirmations = [...this.stoppers].map((stop) => {
        try {
          return stop().catch(() => false);
        } catch {
          return Promise.resolve(false);
        }
      });
      void Promise.all(confirmations).then(
        (results) => finish(results.every(Boolean) ? this.result : 'shutdown_incomplete'),
        () => finish('shutdown_incomplete'),
      );
    }
  }
  finish(): Promise<WorkflowResult> {
    this.close('finished');
    return this.completion!;
  }
}
type SlotControl = { stop(): Promise<boolean>; renew(): Promise<boolean> };
type AuthorityControl = {
  options: AuthorityOptions;
  slots: Set<SlotControl>;
  reserved: boolean;
};
const controls = new WeakMap<WorkflowAuthority, AuthorityControl>();

function permitted(
  permission: RuntimePermission | null,
  scope: WorkflowScope,
  paneId: string,
): permission is RuntimePermission {
  return (
    permission !== null &&
    permission.serverId === scope.serverId &&
    permission.enabled === true &&
    typeof permission.autoApprove === 'boolean' &&
    (permission.targets === 'all' ||
      (Array.isArray(permission.targets) &&
        permission.targets.every((target) => typeof target === 'string') &&
        permission.targets.includes(paneId)))
  );
}

export function beginWorkflow(options: AuthorityOptions): WorkflowAttempt {
  options = { ...options, scope: { ...options.scope } };
  const lifetime = new Lifetime(options.shutdownDeadline);
  const close = () => lifetime.close();
  options.signal.addEventListener('abort', close, { once: true });
  lifetime.controller.signal.addEventListener('abort', () => options.signal.removeEventListener('abort', close), {
    once: true,
  });
  if (options.signal.aborted) close();
  const ready = (async (): Promise<WorkflowAuthority | null> => {
    try {
      const scope = Object.freeze(validateWorkflowScope(options.scope));
      if (
        !/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(options.paneId) ||
        options.paneId.length > 256 ||
        options.workspaceId !== options.paneId.split(':')[0]
      )
        throw new Error('invalid workflow pane');
      assertNoCredentials(
        [options.paneId, options.workspaceId],
        configuredApiKeys({
          TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
          OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        }),
      );
      const initial = await options.permission();
      if (!lifetime.open()) return null;
      if (!permitted(initial, scope, options.paneId)) {
        lifetime.close('not_admitted');
        return null;
      }
      const permission = Object.freeze({
        ...initial,
        targets: initial.targets === 'all' ? ('all' as const) : Object.freeze([...initial.targets]),
      });
      const snapshot = JSON.stringify({ autoApprove: permission.autoApprove, targets: permission.targets });
      if (!(await options.state.legacyInactive()) || !lifetime.open()) {
        lifetime.close('not_admitted');
        return null;
      }
      const captured = await options.state.capture(scope.serverId, initial.enabled);
      if (!lifetime.open()) return null;
      if (!captured || !(await options.state.matches(captured))) {
        lifetime.close('not_admitted');
        return null;
      }
      if (!lifetime.open()) return null;
      const ticket = Object.freeze({ ...captured });
      const lease = options.state.lease(scope);
      const attempt = lease.beginAcquire(workflowSession(scope));
      const handle = new OwnedHandle(attempt);
      lifetime.stoppers.add(() => handle.stop());
      const acquired = await attempt.ready;
      if (!lifetime.open()) return null;
      const generation = acquired ?? (await lease.activeToken(workflowSession(scope)));
      if (!generation || !lifetime.open()) {
        lifetime.close('not_admitted');
        return null;
      }
      const slots = new Set<SlotControl>();
      // Owners may bootstrap without a binding; admitted invocations require one.
      let admitted = false;
      const authority: WorkflowAuthority = Object.freeze({
        scope,
        paneId: options.paneId,
        workspaceId: options.workspaceId,
        permission,
        ticket,
        generation,
        ownsGeneration: acquired !== null,
        signal: lifetime.controller.signal,
        admissionOpen: () => lifetime.open(),
        dispatch: async (kind, effect, proof) => {
          const admitted = await options.state.dispatchAdmittedEffect(scope, ticket, effect, {
            generation,
            open: () => lifetime.open(),
            revalidate: async () =>
              (kind !== 'approval' || permission.autoApprove === true) &&
              (await authority.valid()) &&
              (kind !== 'recovery' || !(await options.state.recoveryQuarantined(scope))) &&
              (!proof || (await proof.valid())),
            reserve: proof ? (action) => proof.reserve(action) : undefined,
          });
          if (!admitted) throw new Error('lost workflow effect authority');
        },
        valid: async () => {
          if (!lifetime.open()) return false;
          let allowed = false;
          try {
            const current = await options.permission();
            // Validate scoped identity and every workflow ancestor on each check.
            const recorded = await options.state.binding(scope);
            allowed =
              lifetime.open() &&
              permitted(current, scope, options.paneId) &&
              JSON.stringify({ autoApprove: current.autoApprove, targets: current.targets }) === snapshot &&
              (await options.state.matches(ticket)) &&
              (await options.state.legacyInactive()) &&
              (await lease.leaseMatches(generation, workflowSession(scope))) &&
              (!admitted || recorded !== null);
          } catch {
            allowed = false;
          }
          if (!allowed) lifetime.close();
          return allowed && lifetime.open();
        },
      });
      controls.set(authority, { options, slots, reserved: false });
      lifetime.stoppers.add(async () => (await Promise.all([...slots].map((slot) => slot.stop()))).every(Boolean));
      if (!(await authority.valid()) || !lifetime.open()) return null;
      const previous = await options.state.binding(scope);
      if (!lifetime.open()) return null;
      if (!authority.ownsGeneration && previous === null) {
        lifetime.close('not_admitted');
        return null;
      }
      // Readers may index another view, but can never replace the owner's binding.
      await options.state.recordBinding(
        previous
          ? {
              ...previous,
              paneId: options.paneId,
              workspaceId: options.workspaceId,
              epoch: ticket.epoch,
              generation,
              phase: 'observing',
              reason: null,
            }
          : {
              protocol: 1,
              scope,
              epoch: ticket.epoch,
              generation,
              paneId: options.paneId,
              workspaceId: options.workspaceId,
              historyPaneId: options.paneId,
              failureEpisodeId: null,
              phase: 'observing',
              reason: null,
            },
        authority,
      );
      admitted = true;
      if (!(await authority.valid()) || !lifetime.open()) return null;
      let renewing = false;
      const tick = () => {
        if (!lifetime.open() || renewing) return;
        renewing = true;
        const renew = async () => {
          if (!(await authority.valid())) return false;
          if (authority.ownsGeneration && !(await lease.heartbeat(generation, workflowSession(scope)))) return false;
          return (await Promise.all([...slots].map((slot) => slot.renew()))).every(Boolean);
        };
        void renew().then(
          (ok) => {
            renewing = false;
            if (!ok) lifetime.close();
          },
          () => {
            renewing = false;
            lifetime.close();
          },
        );
      };
      const cancelHeartbeat = (
        options.scheduleHeartbeat ??
        ((callback) => {
          const timer = setInterval(callback, options.heartbeatIntervalMs ?? 5000);
          return () => clearInterval(timer);
        })
      )(tick);
      lifetime.controller.signal.addEventListener('abort', cancelHeartbeat, { once: true });
      return authority;
    } catch {
      lifetime.close('not_admitted');
      return null;
    }
  })();
  return {
    ready,
    signal: lifetime.controller.signal,
    close,
    finish: () => {
      const done = lifetime.finish();
      void done.then((result) => {
        if (result !== 'shutdown_incomplete') return;
        const diagnose =
          options.diagnose ?? ((event: DiagnosticEvent) => appendDiagnostic(options.state.directory, event));
        void diagnose({
          at: new Date().toISOString(),
          scopeHash: createHash('sha256').update(workflowSession(options.scope)).digest('hex'),
          outcome: 'shutdown_incomplete',
          reason: 'release_unconfirmed',
        }).catch(() => {});
      });
      return done;
    },
  };
}

export function reserveJobSlot(state: WorkflowState, authority: WorkflowAuthority): JobSlotAttempt {
  const parent = controls.get(authority);
  const lifetime = new Lifetime(parent?.options.shutdownDeadline);
  if (
    !parent ||
    parent.options.state !== state ||
    parent.reserved ||
    !authority.ownsGeneration ||
    !authority.admissionOpen()
  ) {
    lifetime.close('not_admitted');
    return {
      ready: Promise.resolve(null),
      duplicate: parent?.reserved === true,
      close: () => lifetime.close(),
      finish: () => lifetime.finish(),
    };
  }
  // Claim locally before the first permission or capacity-publication await.
  parent.reserved = true;
  const handles: OwnedHandle[] = [];
  let lease: SchedulerLeaseStore | undefined;
  let token: string | undefined;
  const session = JSON.stringify([
    createHash('sha256').update(workflowSession(authority.scope)).digest('hex'),
    authority.generation,
  ]);
  let bindingProof: WorkflowBinding | undefined;
  let historyProof: Episode | undefined;
  let writing: Episode | undefined;
  const episodes = new EpisodeStore(state.directory);
  const pendingMatches = async (): Promise<boolean> => {
    // A renewal can read the old side of our write and resume after it commits.
    // Retain only this check's admitted snapshots, not a history of old proofs.
    const previousProof = historyProof;
    const previousWrite = writing;
    const binding = await state.binding(authority.scope);
    const episode = await state.sessionRetry(authority.scope);
    const matches =
      binding !== null &&
      binding.phase === 'pending' &&
      binding.paneId === parent.options.paneId &&
      binding.workspaceId === parent.options.workspaceId &&
      binding.epoch === authority.ticket.epoch &&
      binding.generation === authority.generation &&
      episode !== null &&
      binding.historyPaneId === episode.pane_id &&
      binding.failureEpisodeId === episode.failure_episode_id &&
      (bindingProof
        ? isDeepStrictEqual(binding, bindingProof) &&
          [previousProof, previousWrite, historyProof, writing].some(
            (proof) => proof !== undefined && isDeepStrictEqual(episode, proof),
          )
        : episode.last_delivery_state === 'none' &&
          episode.next_check_at !== null &&
          episode.lifecycle_handoff_sent !== true) &&
      !(await state.recoveryQuarantined(authority.scope));
    if (matches && !bindingProof) {
      bindingProof = binding!;
      historyProof = episode!;
    }
    return matches;
  };
  const stopHandles = async () => {
    const confirmed = (await Promise.all(handles.map((handle) => handle.stop()))).every(Boolean);
    if (confirmed) {
      parent.reserved = false;
      parent.slots.delete(control);
    }
    return confirmed;
  };
  lifetime.stoppers.add(stopHandles);
  const close = () => lifetime.close();
  const control: SlotControl = {
    stop: () => {
      lifetime.close();
      return stopHandles();
    },
    renew: async () => {
      if (!lifetime.open() || token === undefined) return true;
      const pending = await pendingMatches();
      if (!lifetime.open()) return true;
      const renewed = pending && lease !== undefined && (await lease.heartbeat(token, session));
      return !lifetime.open() || renewed;
    },
  };
  parent.slots.add(control);
  authority.signal.addEventListener('abort', close, { once: true });
  lifetime.controller.signal.addEventListener('abort', () => authority.signal.removeEventListener('abort', close), {
    once: true,
  });
  if (authority.signal.aborted) close();
  const ready = (async (): Promise<JobSlot | null> => {
    try {
      if (!lifetime.open() || !(await authority.valid())) {
        lifetime.close('not_admitted');
        return null;
      }
      if (!(await pendingMatches())) {
        lifetime.close('not_admitted');
        return null;
      }
      for (let index = 0; index < 8; index++) {
        if (!lifetime.open() || !(await authority.valid()) || !lifetime.open()) return null;
        await state.validateCapacity(authority.scope.serverId, index);
        if (!lifetime.open()) return null;
        const candidate = state.capacity(authority.scope.serverId, index);
        // The existing acquisition protocol prepares and validates each slot;
        // a refused/stranded handle never reclaims the occupied generation.
        let acquisition: LeaseAttempt | undefined;
        await authority.dispatch('recovery', async () => {
          if (!lifetime.open()) throw new Error('closed capacity admission');
          acquisition = candidate.beginAcquire(session);
          handles.push(new OwnedHandle(acquisition));
        });
        const acquired = await acquisition!.ready;
        if (!lifetime.open()) return null;
        if (acquired) {
          lease = candidate;
          token = acquired;
          break;
        }
      }
      if (!lease || !token || !(await authority.valid()) || !(await pendingMatches()) || !lifetime.open()) {
        lifetime.close('not_admitted');
        return null;
      }
      const selected = lease,
        generation = token;
      const valid = async () => {
        if (!lifetime.open()) return false;
        let allowed = false;
        try {
          allowed =
            (await authority.valid()) && (await pendingMatches()) && (await selected.owned(generation, session));
        } catch {
          allowed = false;
        }
        if (!allowed) lifetime.close();
        return allowed && lifetime.open();
      };
      const proof: EffectProof = { valid, reserve: (action) => selected.withGenerationGuard(generation, action) };
      const dispatch = (effect: () => Promise<void>) => authority.dispatch('recovery', effect, proof);
      return {
        signal: lifetime.controller.signal,
        valid,
        dispatch,
        record: async (episode) => {
          const next = parseEpisode(episode);
          if (
            writing ||
            !(await valid()) ||
            writing ||
            !lifetime.open() ||
            next.pane_id !== bindingProof!.historyPaneId ||
            next.session_id !== authority.scope.sessionId ||
            next.failure_episode_id !== bindingProof!.failureEpisodeId
          )
            throw new Error('lost job authority');
          // Heartbeats may observe either side of this already-admitted atomic
          // write, never an arbitrary terminal record or a different history.
          writing = next;
          try {
            await dispatch(() => episodes.recordSessionRetry(authority.scope.agent, authority.scope.sessionId, next));
            historyProof = next;
          } catch (error) {
            lifetime.close();
            throw error;
          } finally {
            writing = undefined;
          }
        },
      };
    } catch {
      lifetime.close('not_admitted');
      return null;
    }
  })();
  return { ready, duplicate: false, close, finish: () => lifetime.finish() };
}
