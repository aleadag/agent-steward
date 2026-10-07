import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { SchedulerLeaseStore, type LeaseOptions } from './lease.ts';
import { assertNoCredentials, configuredApiKeys } from '../privacy.ts';
import type { ObservedStop } from './observe.ts';
import { readPrivateJson, withPrivateGuard, writePrivateJson } from './private-files.ts';
import { EpisodeStore, parseEpisode, readEpisodeLockOwner, workflowEpisodeId, type Episode } from './state.ts';

export type WorkflowScope = {
  serverId: string;
  agent: string;
  sessionId: string;
  sessionKind: string;
  sessionSource: string;
};
export type AdmissionTicket = { serverId: string; epoch: string };
export type ControlResult = 'paused' | 'resumed' | 'denied' | 'shutdown_incomplete';
export type WorkflowResult = 'finished' | 'stopped' | 'not_admitted' | 'shutdown_incomplete';
export type RuntimePermission = {
  serverId: string;
  enabled: boolean;
  targets: readonly string[] | 'all';
  autoApprove: boolean;
};
export type WorkflowBinding = {
  protocol: 1;
  scope: WorkflowScope;
  epoch: string;
  generation: string;
  paneId: string;
  workspaceId: string;
  historyPaneId: string;
  failureEpisodeId: string | null;
  phase: 'observing' | 'pending' | 'terminal';
  reason: 'completed' | 'human' | 'canceled' | 'lost' | null;
};
export type WorkflowStateOptions = LeaseOptions & {
  shutdownDeadline?: (ms: number, expire: () => void) => () => void;
};

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim())
  .refine((value) => {
    // eslint-disable-next-line no-control-regex -- Native metadata cannot contain ASCII controls.
    return !/[\x00-\x1f\x7f]/.test(value);
  });
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const pane = z
  .string()
  .regex(/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/)
  .max(256);
const scopeSchema = z.strictObject({
  serverId: identifier,
  agent: identifier,
  sessionId: identifier,
  sessionKind: identifier,
  sessionSource: identifier,
});
export function validateWorkflowScope(value: WorkflowScope): WorkflowScope {
  const scope = scopeSchema.parse(value);
  assertNoCredentials(
    scope,
    configuredApiKeys({
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    }),
  );
  // Herdr 0.9.1 agent_resume.rs: official native sources and snapshot kinds.
  const agents = [
    'claude',
    'codex',
    'copilot',
    'devin',
    'droid',
    'kimi',
    'omp',
    'mastracode',
    'pi',
    'hermes',
    'opencode',
    'qodercli',
    'qwen',
    'kilo',
    'cursor',
    'agy',
    'grok',
    'letta',
  ];
  const source = scope.agent === 'agy' ? 'herdr:antigravity_cli' : `herdr:${scope.agent}`;
  const kind =
    scope.sessionKind === 'id' || (scope.sessionKind === 'path' && (scope.agent === 'pi' || scope.agent === 'omp'));
  if (!agents.includes(scope.agent) || !kind || scope.sessionSource !== source)
    throw new Error('invalid native workflow scope');
  return scope;
}
export const workflowSession = (scope: WorkflowScope): string =>
  JSON.stringify([scope.serverId, scope.agent, scope.sessionId]);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const sameScope = (a: WorkflowScope, b: WorkflowScope): boolean =>
  workflowSession(a) === workflowSession(b) && a.sessionKind === b.sessionKind && a.sessionSource === b.sessionSource;
const bindingSchema = z.strictObject({
  protocol: z.literal(1),
  scope: scopeSchema,
  epoch: uuid,
  generation: uuid,
  paneId: pane,
  workspaceId: identifier,
  historyPaneId: pane,
  failureEpisodeId: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  phase: z.enum(['observing', 'pending', 'terminal']),
  reason: z.enum(['completed', 'human', 'canceled', 'lost']).nullable(),
});
function parseBinding(value: unknown): WorkflowBinding {
  const binding = bindingSchema.parse(value);
  validateWorkflowScope(binding.scope);
  assertNoCredentials(
    binding,
    configuredApiKeys({
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    }),
  );
  if (
    binding.workspaceId !== binding.paneId.split(':')[0] ||
    (binding.phase === 'terminal') !== (binding.reason !== null) ||
    (binding.phase === 'pending' && binding.failureEpisodeId === null)
  )
    throw new Error('invalid workflow binding');
  return binding;
}
const recoverable = (episode: Episode): boolean =>
  episode.last_delivery_state === 'none' && episode.next_check_at !== null && episode.lifecycle_handoff_sent !== true;

const controlSchema = z.strictObject({
  protocol: z.literal(1),
  epoch: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  mode: z.enum(['open', 'paused']),
});
type Control = z.infer<typeof controlSchema>;
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
const defaultDeadline = (ms: number, expire: () => void): (() => void) => {
  const timer = setTimeout(expire, ms);
  return () => clearTimeout(timer);
};

export class WorkflowState {
  private readonly leases = new Map<string, SchedulerLeaseStore>();
  private readonly closed = new Set<string>();
  private readonly revision = new Map<string, symbol>();
  private readonly observed = new Map<string, Set<string>>();
  private readonly revoked = new Map<string, Set<string>>();

  constructor(
    readonly directory: string,
    private readonly now: () => number = () => Date.now(),
    private readonly options: WorkflowStateOptions = {},
  ) {
    // Keep the shared-root preparation contract; administrative epochs do not depend on wall time.
    this.store = new EpisodeStore(directory, now, options);
  }
  private readonly store: EpisodeStore;

  lease(scope: WorkflowScope): SchedulerLeaseStore {
    const selected = validateWorkflowScope(scope);
    return this.leaseAt(this.workflowDirectory(selected), () => this.prepareWorkflow(selected));
  }

  capacity(serverId: string, index: number): SchedulerLeaseStore {
    identifier.parse(serverId);
    assertNoCredentials(
      serverId,
      configuredApiKeys({
        TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      }),
    );
    if (!Number.isInteger(index) || index < 0 || index >= 8) throw new Error('invalid capacity slot');
    const directory = join(dirname(this.path(serverId)), 'capacity', String(index));
    return this.leaseAt(directory, () => this.prepareCapacity(serverId, directory));
  }

  private async prepareCapacity(serverId: string, directory: string): Promise<void> {
    await this.prepare(serverId);
    await this.ensureDirectories([join(dirname(this.path(serverId)), 'capacity'), directory]);
  }

  async validateCapacity(serverId: string, index: number): Promise<void> {
    const lease = this.capacity(serverId, index);
    await this.prepareCapacity(serverId, lease.directory);
    const selected = await lease.inspect();
    if (selected.kind === 'selected') {
      const session = z.tuple([z.string().regex(/^[0-9a-f]{64}$/), uuid]).parse(JSON.parse(selected.identity.session));
      if (JSON.stringify(session) !== selected.identity.session) throw new Error('unknown capacity association');
    }
  }

  async sessionRetry(scope: WorkflowScope): Promise<Episode | null> {
    validateWorkflowScope(scope);
    return this.store.sessionRetry(scope.agent, scope.sessionId);
  }

  private leaseAt(directory: string, prepare: () => Promise<void>): SchedulerLeaseStore {
    let lease = this.leases.get(directory);
    if (!lease) {
      const ancestors = relative(this.directory, directory).split('/').filter(Boolean).slice(0, -1);
      const checkAncestors = async () => {
        await this.safeDirectory(this.directory);
        let path = this.directory;
        for (const name of ancestors) {
          path = join(path, name);
          await this.safeDirectory(path);
        }
      };
      lease = new SchedulerLeaseStore(directory, prepare, this.now, {
        ...this.options,
        io: {
          ...this.options.io,
          lstat: async (path) => {
            await checkAncestors();
            const info = await (this.options.io?.lstat ?? lstat)(path);
            await checkAncestors();
            return info;
          },
        },
      });
      this.leases.set(directory, lease);
    }
    return lease;
  }

  private workflowDirectory(scope: WorkflowScope): string {
    return join(this.directory, 'workflows', hash(workflowSession(scope)));
  }

  private async ensureDirectories(paths: string[]): Promise<void> {
    await this.safeDirectory(this.directory);
    for (const path of paths) {
      await this.safeDirectory(dirname(path));
      try {
        await (this.options.io?.mkdir ?? mkdir)(path, { mode: 0o700 });
        await (this.options.io?.chmod ?? chmod)(path, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await this.safeDirectory(path);
    }
  }

  private async prepareWorkflow(scope: WorkflowScope): Promise<void> {
    await this.store.prepare();
    await this.ensureDirectories([join(this.directory, 'workflows'), this.workflowDirectory(scope)]);
  }

  async binding(scope: WorkflowScope): Promise<WorkflowBinding | null> {
    validateWorkflowScope(scope);
    const directory = this.workflowDirectory(scope);
    try {
      await this.safeDirectory(this.directory);
      await this.safeDirectory(join(this.directory, 'workflows'));
      await this.safeDirectory(directory);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    let value: unknown;
    try {
      value = await readPrivateJson(join(directory, 'binding.json'), 8192, this.options);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const binding = parseBinding(value);
    if (!sameScope(binding.scope, scope)) throw new Error('workflow identity mismatch');
    await this.safeDirectory(this.directory);
    await this.safeDirectory(join(this.directory, 'workflows'));
    return binding;
  }

  async recordBinding(
    value: WorkflowBinding,
    authority?: { valid(): Promise<boolean>; admissionOpen(): boolean },
  ): Promise<void> {
    const requested = parseBinding(value);
    await this.prepareWorkflow(requested.scope);
    const directory = this.workflowDirectory(requested.scope);
    const recorded = await withPrivateGuard(
      directory,
      'binding-guard',
      async () => {
        const write = async (path: string, data: unknown) => {
          const admitted = await this.dispatchAdmittedEffect(
            requested.scope,
            { serverId: requested.scope.serverId, epoch: requested.epoch },
            () => writePrivateJson(path, data, this.options),
            {
              bindingHeld: true,
              generation: requested.generation,
              revalidate: authority ? () => authority.valid() : undefined,
              open: authority ? () => authority.admissionOpen() : undefined,
            },
          );
          if (!admitted) throw new Error('lost workflow binding authority');
        };
        const publish = async () => {
          const previous = await this.binding(requested.scope);
          let selected = requested;
          let episode: Episode | null;
          try {
            episode = await this.store.sessionRetry(requested.scope.agent, requested.scope.sessionId);
          } catch (error) {
            // Unknown recovery history is not independent permission denial.
            if (requested.phase !== 'observing') throw error;
            episode = null;
          }
          if (previous && requested.phase === 'observing' && previous.generation === requested.generation) {
            selected = previous;
          } else if (
            previous &&
            (previous.phase !== 'observing' || previous.failureEpisodeId !== null) &&
            !(await this.store.hasRetryHead(requested.scope.agent, requested.scope.sessionId))
          ) {
            if (requested.phase === 'observing') selected = previous;
            else {
              if (
                requested.historyPaneId !== previous.historyPaneId ||
                requested.failureEpisodeId !== previous.failureEpisodeId ||
                (requested.phase === 'pending' && (previous.phase === 'terminal' || previous.epoch !== requested.epoch))
              )
                throw new Error('unresolved workflow history');
            }
          } else if (episode && requested.phase === 'observing') {
            selected = {
              ...requested,
              historyPaneId: episode.pane_id,
              failureEpisodeId: workflowEpisodeId(episode),
            };
          }
          if (requested.phase !== 'observing') {
            const reference = await this.reference(requested.scope);
            if (
              reference &&
              (reference.historyPaneId !== requested.historyPaneId ||
                (reference.failureEpisodeId !== requested.failureEpisodeId &&
                  !(await this.store.hasRetryHead(requested.scope.agent, requested.scope.sessionId))))
            )
              throw new Error('canonical binding mismatch');
          }
          if (
            requested.phase === 'pending' &&
            (!episode ||
              !recoverable(episode) ||
              episode.pane_id !== selected.historyPaneId ||
              episode.pane_id !== selected.paneId ||
              workflowEpisodeId(episode) !== selected.failureEpisodeId ||
              (await this.recoveryQuarantined(requested.scope)))
          )
            throw new Error('unavailable canonical history');
          if (
            !(await this.matches({
              serverId: requested.scope.serverId,
              epoch: requested.epoch,
            })) ||
            !(await this.lease(requested.scope).leaseMatches(requested.generation, workflowSession(requested.scope)))
          )
            throw new Error('lost workflow authority');
          // Publish the server-independent history pointer before pending promotion.
          if (requested.phase !== 'observing') await write(this.referencePath(requested.scope), selected);
          if (selected !== previous) await write(join(directory, 'binding.json'), selected);
          await this.prepare(requested.scope.serverId);
          const panes = join(dirname(this.path(requested.scope.serverId)), 'panes');
          await this.ensureDirectories([panes]);
          const lookup = join(panes, `${hash(JSON.stringify([requested.paneId]))}.json`);
          const published = await withPrivateGuard(
            panes,
            `${hash(JSON.stringify([requested.paneId]))}.guard`,
            async () => {
              // Fresh generation/epoch fence: a revoked publisher cannot replace lookup.
              if (
                !(await this.matches({
                  serverId: requested.scope.serverId,
                  epoch: requested.epoch,
                })) ||
                !(await this.lease(requested.scope).leaseMatches(
                  requested.generation,
                  workflowSession(requested.scope),
                ))
              )
                throw new Error('lost workflow authority');
              try {
                const existing = this.parseLookup(
                  await readPrivateJson(lookup, 16384, this.options),
                  requested.scope.serverId,
                  requested.paneId,
                );
                if (
                  (!sameScope(existing.scope, selected.scope) || existing.generation !== selected.generation) &&
                  JSON.stringify(existing) === JSON.stringify(await this.binding(existing.scope))
                ) {
                  const held = await this.lease(requested.scope).activeToken(workflowSession(requested.scope));
                  if (held !== selected.generation) throw new Error('newer pane association');
                }
              } catch (error) {
                if (!isMissing(error)) throw error;
              }
              await write(lookup, {
                protocol: 1,
                paneId: requested.paneId,
                binding: selected,
              });
              return true;
            },
            this.options,
          );
          if (!published) throw new Error('workflow lookup busy');
          return true;
        };
        // A timed-out adoption retains this shared lock until its late IO settles.
        return requested.phase !== 'observing'
          ? this.store.withEpisodeLock(
              'retry-session:' + JSON.stringify([requested.scope.agent, requested.scope.sessionId]),
              publish,
            )
          : publish();
      },
      this.options,
    );
    if (!recorded) throw new Error('workflow binding busy');
  }

  private parseLookup(value: unknown, serverId: string, paneId: string): WorkflowBinding {
    const record = z
      .strictObject({
        protocol: z.literal(1),
        paneId: pane,
        binding: bindingSchema,
      })
      .parse(value);
    const binding = parseBinding(record.binding);
    if (record.paneId !== paneId || binding.scope.serverId !== serverId) throw new Error('workflow lookup mismatch');
    return binding;
  }

  async locate(serverId: string, paneId: string): Promise<WorkflowScope | null> {
    try {
      identifier.parse(serverId);
      pane.parse(paneId);
      assertNoCredentials(
        [serverId, paneId],
        configuredApiKeys({
          TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
          OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        }),
      );
      await this.layout(serverId);
      const panes = join(dirname(this.path(serverId)), 'panes');
      await this.safeDirectory(panes);
      const binding = this.parseLookup(
        await readPrivateJson(join(panes, `${hash(JSON.stringify([paneId]))}.json`), 16384, this.options),
        serverId,
        paneId,
      );
      const current = await this.binding(binding.scope);
      if (!current || JSON.stringify(current) !== JSON.stringify(binding)) return null;
      await this.layout(serverId);
      return current.scope;
    } catch {
      return null;
    }
  }

  private referencePath(scope: WorkflowScope): string {
    return join(this.directory, `retry-session-${hash(JSON.stringify([scope.agent, scope.sessionId]))}.binding.json`);
  }

  private async reference(scope: WorkflowScope): Promise<WorkflowBinding | null> {
    let value: unknown;
    try {
      value = await readPrivateJson(this.referencePath(scope), 8192, this.options);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const reference = parseBinding(value);
    if (
      reference.phase === 'observing' ||
      reference.scope.agent !== scope.agent ||
      reference.scope.sessionId !== scope.sessionId
    )
      throw new Error('invalid canonical binding');
    return reference;
  }

  async recoveryQuarantined(scope: WorkflowScope, forCompletion = false): Promise<boolean> {
    validateWorkflowScope(scope);
    await this.store.prepare();
    const prefix = `retry-session-${hash(JSON.stringify([scope.agent, scope.sessionId]))}`;
    try {
      await (this.options.io?.lstat ?? lstat)(join(this.directory, `${prefix}.association-guard`));
      return true;
    } catch (error) {
      if (!isMissing(error)) return true;
    }
    const marker = join(this.directory, `${prefix}.quarantine.json`);
    try {
      const value = z
        .strictObject({
          protocol: z.literal(1),
          agent: identifier,
          sessionId: identifier,
          quarantined: z.literal(true),
        })
        .parse(await readPrivateJson(marker, 8192, this.options));
      if (value.agent !== scope.agent || value.sessionId !== scope.sessionId) throw new Error('invalid association');
      if (!forCompletion && !(await this.store.hasRetryHead(scope.agent, scope.sessionId))) return true;
    } catch (error) {
      if (!isMissing(error)) return true;
    }
    try {
      const reference = await this.reference(scope);
      const selected = await this.store.sessionRetry(scope.agent, scope.sessionId);
      const hasHead = await this.store.hasRetryHead(scope.agent, scope.sessionId);
      if (!reference) return hasHead && selected !== null;
      if (hasHead && selected && reference.failureEpisodeId !== workflowEpisodeId(selected)) return true;
      if (
        (reference.phase === 'terminal' &&
          (reference.reason === 'canceled' ||
            reference.reason === 'lost' ||
            (!forCompletion &&
              !(await this.store.hasRetryHead(scope.agent, scope.sessionId)) &&
              (await this.store.sessionRetry(scope.agent, scope.sessionId))?.last_delivery_state !== 'delivered'))) ||
        reference.scope.sessionSource !== scope.sessionSource ||
        reference.scope.sessionKind !== scope.sessionKind ||
        !(await this.matches({
          serverId: reference.scope.serverId,
          epoch: reference.epoch,
        }))
      )
        return true;
      // A new server cannot assume a known old owner has stopped merely because
      // its selector is absent, expired, corrupt or live under a successor token.
      return (
        reference.scope.serverId !== scope.serverId &&
        !(await this.inactiveLease(this.lease(reference.scope), false, workflowSession(reference.scope)))
      );
    } catch {
      return true;
    }
  }

  adoptLegacyRetry(
    episodes: EpisodeStore,
    scope: WorkflowScope,
    observed: ObservedStop,
    authority?: {
      ticket: AdmissionTicket;
      generation: string;
      valid(): Promise<boolean>;
      admissionOpen(): boolean;
    },
    completed = false,
  ): Promise<'absent' | 'adopted' | 'quarantined'> {
    type Result = 'absent' | 'adopted' | 'quarantined';
    return new Promise((resolve) => {
      let expired = false,
        settled = false;
      let cancel = () => {};
      const finish = (result: Result) => {
        if (settled) return;
        settled = true;
        cancel();
        resolve(result);
      };
      try {
        cancel = (this.options.shutdownDeadline ?? defaultDeadline)(2000, () => {
          expired = true;
          finish('quarantined');
        });
        if (settled) cancel();
      } catch {
        expired = true;
        finish('quarantined');
      }
      if (expired) return;
      const effect = async (dispatch: () => Promise<void>) => {
        if (!authority) return dispatch();
        const admitted = await this.dispatchAdmittedEffect(scope, authority.ticket, dispatch, {
          generation: authority.generation,
          revalidate: () => authority.valid(),
          open: () => !expired && authority.admissionOpen(),
        });
        if (!admitted) throw new Error('lost association authority');
      };
      const operation = async (): Promise<Result> => {
        validateWorkflowScope(scope);
        if (
          episodes.directory !== this.directory ||
          observed.agent !== scope.agent ||
          observed.session_id !== scope.sessionId ||
          observed.session_kind !== scope.sessionKind ||
          observed.session_source !== scope.sessionSource ||
          observed.workspace_id !== observed.pane_id.split(':')[0]
        )
          return 'quarantined';
        pane.parse(observed.pane_id);
        if (
          !['idle', 'done', 'blocked'].includes(observed.status) ||
          !Number.isSafeInteger(observed.revision) ||
          !Number.isSafeInteger(observed.state_change_seq) ||
          Buffer.byteLength(observed.context, 'utf8') > 2048 ||
          !observed.context.trim() ||
          hash(observed.context) !== observed.error_evidence_digest ||
          hash(
            JSON.stringify([
              observed.pane_id,
              observed.workspace_id,
              observed.agent,
              observed.session_kind,
              observed.session_source,
              observed.session_id,
              observed.revision,
              observed.state_change_seq,
              observed.status,
              observed.error_evidence_digest,
            ]),
          ) !== observed.current_episode_id
        )
          return 'quarantined';
        assertNoCredentials(
          observed,
          configuredApiKeys({
            TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
            OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
          }),
        );
        const result = await episodes.withEpisodeLock(
          'retry-session:' + JSON.stringify([scope.agent, scope.sessionId]),
          async (): Promise<Result> => {
            const marker = join(
              this.directory,
              `retry-session-${hash(JSON.stringify([scope.agent, scope.sessionId]))}.quarantine.json`,
            );
            const quarantine = async (): Promise<Result> => {
              await effect(() =>
                writePrivateJson(
                  marker,
                  {
                    protocol: 1,
                    agent: scope.agent,
                    sessionId: scope.sessionId,
                    quarantined: true,
                  },
                  this.options,
                ),
              );
              return 'quarantined';
            };
            try {
              const current = await episodes.sessionRetry(scope.agent, scope.sessionId);
              if (await this.recoveryQuarantined(scope, completed)) return 'quarantined';
              if (completed && current)
                return current.pane_id === observed.pane_id &&
                  current.last_delivery_state !== 'uncertain' &&
                  !(
                    current.last_delivery_state === 'human' &&
                    current.attempt_count !== 0 &&
                    !(await episodes.hasRetryHead(scope.agent, scope.sessionId))
                  ) &&
                  !current.lifecycle_handoff_sent &&
                  !expired
                  ? 'adopted'
                  : 'quarantined';
              if (!current && (await episodes.hasRetryHead(scope.agent, scope.sessionId))) return 'absent';
              if (current)
                return recoverable(current) &&
                  current.failure_episode_id === observed.current_episode_id &&
                  current.error_evidence_digest === observed.error_evidence_digest &&
                  !expired
                  ? 'adopted'
                  : 'quarantined';
              const associationName = `retry-session-${hash(JSON.stringify([scope.agent, scope.sessionId]))}.association-guard`;
              const associated = await withPrivateGuard(
                this.directory,
                associationName,
                async () => {
                  const names = await (this.options.io?.readdir ?? readdir)(this.directory);
                  const ownLock =
                    hash('retry-session:' + JSON.stringify([scope.agent, scope.sessionId])) + '.json.lock';
                  const stat = this.options.io?.lstat ?? lstat;
                  for (const name of names) {
                    if (name === ownLock || !/^[0-9a-f]{64}\.json\./.test(name)) continue;
                    if (/^[0-9a-f]{64}\.json\.lock(?:\.takeover)?$/.test(name)) {
                      try {
                        if (!(await stat(join(this.directory, name))).isDirectory()) return quarantine();
                      } catch {
                        return quarantine();
                      }
                      const lockName = name.endsWith('.takeover') ? name.slice(0, -'.takeover'.length) : name;
                      const record = await readEpisodeLockOwner(join(this.directory, lockName));
                      if (!record || hash(record.session) + '.json.lock' !== lockName) return quarantine();
                      if (
                        record.session === observed.pane_id ||
                        record.session.startsWith('retry-session:') ||
                        record.session.startsWith('approval:')
                      )
                        continue;
                    }
                    return quarantine();
                  }
                  const matches: Episode[] = [];
                  for (const name of names.filter((name) => /^[0-9a-f]{64}\.json$/.test(name))) {
                    if (expired) return quarantine();
                    const legacy = parseEpisode(await readPrivateJson(join(this.directory, name), 8192, this.options));
                    assertNoCredentials(
                      legacy,
                      configuredApiKeys({
                        TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
                        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
                      }),
                    );
                    if (hash(legacy.pane_id) + '.json' !== name) return quarantine();
                    if (legacy.session_id === scope.sessionId) matches.push(legacy);
                  }
                  if (expired) return quarantine();
                  if (matches.length === 0) return 'absent';
                  const legacy = matches[0]!;
                  if (
                    matches.length !== 1 ||
                    legacy.pane_id !== observed.pane_id ||
                    (completed
                      ? legacy.last_delivery_state !== 'human' ||
                        legacy.attempt_count !== 0 ||
                        legacy.lifecycle_handoff_sent
                      : legacy.failure_episode_id !== observed.current_episode_id ||
                        legacy.error_evidence_digest !== observed.error_evidence_digest ||
                        !recoverable(legacy))
                  )
                    return quarantine();
                  await effect(() => episodes.recordSessionRetry(scope.agent, scope.sessionId, legacy));
                  return expired ? quarantine() : 'adopted';
                },
                {
                  ...this.options,
                  io: {
                    ...this.options.io,
                    unlink: async (path) => {
                      if (path === join(this.directory, associationName) && expired)
                        throw new Error('expired legacy association');
                      await (this.options.io?.unlink ?? unlink)(path);
                      if (expired) throw new Error('expired legacy association');
                    },
                  },
                },
              );
              return associated ?? 'quarantined';
            } catch {
              return quarantine();
            }
          },
        );
        return result ?? 'quarantined';
      };
      void operation().then(
        (result) => finish(expired ? 'quarantined' : result),
        () => finish('quarantined'),
      );
    });
  }

  async legacyInactive(): Promise<boolean> {
    try {
      await this.store.prepare();
      return this.inactiveLease(
        this.leaseAt(this.directory, () => this.store.prepare()),
        true,
      );
    } catch {
      return false;
    }
  }

  private async inactiveLease(lease: SchedulerLeaseStore, absentAllowed: boolean, session?: string): Promise<boolean> {
    try {
      try {
        await (this.options.io?.lstat ?? lstat)(join(lease.directory, 'takeover-guard'));
        return false;
      } catch (error) {
        if (!isMissing(error)) return false;
      }
      const selected = await lease.inspect();
      if (selected.kind === 'absent') return absentAllowed;
      if (session !== undefined && selected.identity.session !== session) return false;
      if (selected.released) return true;
      const now = this.now();
      if (!Number.isFinite(now) || selected.heartbeat.heartbeat + 15000 > now) return false;
      if (this.options.alive) return this.options.alive(selected.identity.pid) === false;
      try {
        process.kill(selected.identity.pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    } catch {
      return false;
    }
  }

  async capture(serverId: string, enabled: boolean): Promise<AdmissionTicket | null> {
    if (enabled !== true || !serverId || this.closed.has(serverId)) return null;
    const revision = this.revision.get(serverId);
    try {
      const path = await this.prepare(serverId);
      const selected = await withPrivateGuard(
        dirname(path),
        'control-guard',
        async () => {
          let control = await this.read(serverId, path);
          if (control === null) {
            if (this.closed.has(serverId)) return null;
            control = { protocol: 1, epoch: randomUUID(), mode: 'open' };
            await writePrivateJson(path, control, this.options);
          }
          const confirmed = await this.read(serverId, path);
          if (!confirmed || confirmed.epoch !== control.epoch || confirmed.mode !== 'open') return null;
          return confirmed;
        },
        this.options,
      );
      if (
        !selected ||
        this.revision.get(serverId) !== revision ||
        this.closed.has(serverId) ||
        this.revoked.get(serverId)?.has(selected.epoch)
      )
        return null;
      this.remember(serverId, selected.epoch);
      return { serverId, epoch: selected.epoch };
    } catch {
      return null;
    }
  }

  private admissionLive(ticket: AdmissionTicket): boolean {
    return (
      !!ticket.serverId &&
      !!ticket.epoch &&
      !this.closed.has(ticket.serverId) &&
      !this.revoked.get(ticket.serverId)?.has(ticket.epoch)
    );
  }

  async publishPendingRecoveryProvenance(
    scope: WorkflowScope,
    ticket: AdmissionTicket,
    generation: string,
    paneId: string,
    workspaceId: string,
    episode: Episode,
  ): Promise<void> {
    if (episode.last_delivery_state !== 'none' || episode.lifecycle_handoff_sent) return;
    const selected = parseBinding({
      protocol: 1,
      scope,
      epoch: ticket.epoch,
      generation,
      paneId,
      workspaceId,
      historyPaneId: episode.pane_id,
      failureEpisodeId: workflowEpisodeId(episode),
      phase: 'pending',
      reason: null,
    });
    if (
      selected.paneId !== episode.pane_id ||
      selected.historyPaneId !== episode.pane_id ||
      selected.scope.sessionId !== episode.session_id
    )
      return;
    try {
      const existing = await this.reference(scope);
      if (
        existing &&
        ((existing.phase === 'terminal' && (existing.reason === 'canceled' || existing.reason === 'lost')) ||
          existing.epoch !== ticket.epoch ||
          (existing.failureEpisodeId !== selected.failureEpisodeId &&
            !(await this.store.hasRetryHead(scope.agent, scope.sessionId))) ||
          existing.historyPaneId !== selected.historyPaneId)
      )
        return;
    } catch {
      return;
    }
    await writePrivateJson(this.referencePath(scope), selected, this.options);
  }

  async recordAdmittedSessionRetry(
    scope: WorkflowScope,
    ticket: AdmissionTicket,
    episode: Episode,
    revalidate?: () => Promise<boolean>,
    generation?: string,
  ): Promise<boolean> {
    return this.dispatchAdmittedEffect(
      scope,
      ticket,
      () => this.store.recordSessionRetry(scope.agent, scope.sessionId, episode),
      { revalidate, generation },
    );
  }

  async dispatchAdmittedEffect(
    scope: WorkflowScope,
    ticket: AdmissionTicket,
    dispatch: () => Promise<void>,
    options: {
      revalidate?: () => Promise<boolean>;
      generation?: string;
      reserve?: (action: (assertGuard: () => Promise<void>) => Promise<boolean>) => Promise<boolean | null>;
      bindingHeld?: boolean;
      open?: () => boolean;
    } = {},
  ): Promise<boolean> {
    validateWorkflowScope(scope);
    const live = () => this.admissionLive(ticket) && (options.open?.() ?? true);
    if (ticket.serverId !== scope.serverId || !live()) return false;
    // Reserve against durable epoch publication, including across independent
    // processes. A pending read is NOT admission: pause must report incomplete
    // while this reservation is held, or publish before it and deny the writer.
    let authorize!: (allowed: boolean) => void;
    const authorized = new Promise<boolean>((resolve) => {
      authorize = resolve;
    });
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const reserve = (assertBinding?: () => Promise<void>) =>
      withPrivateGuard(
        dirname(this.path(ticket.serverId)),
        'control-guard',
        async (assertGuard) => {
          if (!(await this.matches(ticket))) return false;
          const validate = async (assertGeneration?: () => Promise<void>, assertSlot?: () => Promise<void>) => {
            if (!(await this.matches(ticket))) return false;
            if (options.revalidate && !(await options.revalidate())) return false;
            if (
              options.generation &&
              !(await this.lease(scope).leaseMatches(options.generation, workflowSession(scope)))
            )
              return false;
            if (assertBinding) await assertBinding();
            await assertGuard();
            if (assertGeneration) await assertGeneration();
            if (assertSlot) await assertSlot();
            if (!live()) return false;
            authorize(true);
            // Only join synchronous writer/transport invocation, not its ACK/IO.
            await start;
            return true;
          };
          const slot = (assertGeneration?: () => Promise<void>) =>
            options.reserve
              ? options.reserve((assertSlot) => validate(assertGeneration, assertSlot))
              : validate(assertGeneration);
          return options.generation ? this.lease(scope).withGenerationGuard(options.generation, slot) : slot();
        },
        this.options,
      );
    // Located exit writers retain their exact binding while refreshing the
    // captured G/socket/native permission proofs. Both guards are try-locks:
    // pane -> retry -> binding -> control never waits on a competing publisher.
    const reservation =
      options.revalidate && !options.bindingHeld
        ? withPrivateGuard(this.workflowDirectory(scope), 'binding-guard', reserve, this.options)
        : reserve();
    void reservation.then(
      () => authorize(false),
      () => authorize(false),
    );
    // This continuation retains the caller's publication guards, not the new
    // admission reservations' async context. Their lifetime ends at dispatch, while
    // recordSessionRetry's own history/publication guard lasts through its IO.
    let write: Promise<{ error: unknown } | null> | undefined;
    try {
      if ((await authorized) && live()) {
        // Linearization: every reservation is still held at actual invocation.
        write = dispatch().then(
          () => null,
          (error: unknown) => ({ error }),
        );
      }
    } finally {
      started();
    }
    await reservation;
    if (!write) return false;
    const failure = await write;
    if (failure) throw failure.error;
    return true;
  }

  async matches(ticket: AdmissionTicket): Promise<boolean> {
    if (!this.admissionLive(ticket)) return false;
    const revision = this.revision.get(ticket.serverId);
    try {
      const control = await this.read(ticket.serverId, this.path(ticket.serverId));
      if (
        !control ||
        control.mode !== 'open' ||
        control.epoch !== ticket.epoch ||
        this.revision.get(ticket.serverId) !== revision ||
        this.closed.has(ticket.serverId) ||
        this.revoked.get(ticket.serverId)?.has(ticket.epoch)
      )
        return false;
      this.remember(ticket.serverId, ticket.epoch);
      return true;
    } catch {
      return false;
    }
  }

  pause(serverId: string, deadlineAt?: number): Promise<ControlResult> {
    this.closed.add(serverId);
    const revoked = this.revoked.get(serverId) ?? new Set<string>();
    for (const epoch of this.observed.get(serverId) ?? []) revoked.add(epoch);
    this.revoked.set(serverId, revoked);
    return this.control(serverId, 'paused', true, deadlineAt);
  }

  resume(serverId: string, enabled: boolean, deadlineAt?: number): Promise<ControlResult> {
    if (enabled !== true) return Promise.resolve('denied');
    return this.control(serverId, 'open', enabled, deadlineAt);
  }

  private control(
    serverId: string,
    mode: Control['mode'],
    enabled: boolean,
    deadlineAt?: number,
  ): Promise<ControlResult> {
    const end = deadlineAt ?? performance.now() + 5000;
    const revision = Symbol();
    this.revision.set(serverId, revision);
    return new Promise((resolve) => {
      let settled = false;
      let expired = false;
      let cancel = () => {};
      const finish = (result: ControlResult) => {
        if (settled) return;
        settled = true;
        cancel();
        resolve(result);
      };
      try {
        cancel = (this.options.shutdownDeadline ?? defaultDeadline)(
          deadlineAt === undefined ? 5000 : Math.max(0, deadlineAt - performance.now()),
          () => {
            expired = true;
            finish('shutdown_incomplete');
          },
        );
        if (settled) cancel();
      } catch {
        expired = true;
        finish('shutdown_incomplete');
      }
      if (expired) return;
      const superseded = () => expired || performance.now() >= end || this.revision.get(serverId) !== revision;
      const operation = this.update(serverId, mode, enabled, superseded);
      void operation.then(
        (result) => {
          if (superseded()) return finish('shutdown_incomplete');
          if (result === 'resumed') this.closed.delete(serverId);
          finish(result);
        },
        () => finish('shutdown_incomplete'),
      );
    });
  }

  private async update(
    serverId: string,
    mode: Control['mode'],
    enabled: boolean,
    expired: () => boolean,
  ): Promise<ControlResult> {
    if (!serverId || !enabled) return 'denied';
    let path: string;
    try {
      path = await this.prepare(serverId);
    } catch {
      return 'denied';
    }
    const result = await withPrivateGuard(
      dirname(path),
      'control-guard',
      async (): Promise<ControlResult> => {
        let previous: Control | null;
        try {
          previous = await this.read(serverId, path);
        } catch {
          return 'denied';
        }
        if (expired()) return 'shutdown_incomplete';
        if (mode === 'open' && previous === null) return 'denied';
        if (previous?.mode === mode) return mode === 'paused' ? 'paused' : 'resumed';
        const selected: Control = { protocol: 1, epoch: randomUUID(), mode };
        await writePrivateJson(path, selected, this.options);
        const confirmed = await this.read(serverId, path);
        if (!confirmed || confirmed.epoch !== selected.epoch || confirmed.mode !== mode) return 'shutdown_incomplete';
        return mode === 'paused' ? 'paused' : 'resumed';
      },
      this.options,
    );
    return result ?? 'shutdown_incomplete';
  }

  private remember(serverId: string, epoch: string): void {
    const epochs = this.observed.get(serverId) ?? new Set<string>();
    epochs.add(epoch);
    this.observed.set(serverId, epochs);
  }

  private path(serverId: string): string {
    return join(
      this.directory,
      'automation',
      createHash('sha256')
        .update(JSON.stringify([serverId]))
        .digest('hex'),
      'control.json',
    );
  }

  private async safeDirectory(path: string): Promise<void> {
    const info = await (this.options.io?.lstat ?? lstat)(path);
    const uid = process.getuid?.();
    if (uid === undefined || !info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700)
      throw new Error('unsafe private workflow directory');
  }

  private async layout(serverId: string): Promise<void> {
    await this.safeDirectory(this.directory);
    await this.safeDirectory(join(this.directory, 'automation'));
    await this.safeDirectory(dirname(this.path(serverId)));
  }

  private async prepare(serverId: string): Promise<string> {
    await this.store.prepare();
    await this.safeDirectory(this.directory);
    for (const path of [join(this.directory, 'automation'), dirname(this.path(serverId))]) {
      try {
        await (this.options.io?.mkdir ?? mkdir)(path, { mode: 0o700 });
        await (this.options.io?.chmod ?? chmod)(path, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await this.safeDirectory(path);
    }
    await this.layout(serverId);
    return this.path(serverId);
  }

  private async read(serverId: string, path: string): Promise<Control | null> {
    await this.layout(serverId);
    let value: unknown;
    try {
      value = await readPrivateJson(path, 8192, this.options);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const entries = await (this.options.io?.readdir ?? readdir)(dirname(path));
      if (entries.some((name) => name !== 'control-guard')) throw new Error('incomplete workflow control');
      await this.layout(serverId);
      return null;
    }
    await this.layout(serverId);
    return controlSchema.parse(value);
  }
}
