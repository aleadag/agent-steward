import { appendFile } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { beginWorkflow } from '../src/herdr-adapter/authority.ts';
import { WorkflowState } from '../src/herdr-adapter/workflow-state.ts';

const root = process.env.ADMISSION_TEST_ROOT!;
const pane = process.env.ADMISSION_TEST_PANE!;
const state = new WorkflowState(root, undefined, {
  io: {
    open: async (path, flags, mode) => {
      try {
        return await open(path, flags, mode);
      } catch (error) {
        if (path.endsWith('control-guard') && (error as NodeJS.ErrnoException).code === 'EEXIST')
          console.log('contended');
        throw error;
      }
    },
  },
});
const attempt = beginWorkflow({
  state,
  scope: {
    serverId: '47:1',
    agent: 'pi',
    sessionId: `/tmp/${pane}.jsonl`,
    sessionKind: 'path',
    sessionSource: 'herdr:pi',
  },
  paneId: `${pane}:p1`,
  workspaceId: pane,
  permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all', autoApprove: true }),
  signal: new AbortController().signal,
});
try {
  const authority = await attempt.ready;
  if (authority)
    await authority.dispatch('recovery', () => appendFile(join(root, 'effects'), `${pane}\n`, { mode: 0o600 }));
  console.log(JSON.stringify({ admitted: authority !== null, result: await attempt.finish() }));
} finally {
  await attempt.finish();
}
