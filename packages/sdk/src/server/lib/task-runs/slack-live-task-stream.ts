import {
  renderSlackLiveTaskCard,
  syncSlackCodeChannelForTask,
  type SlackLiveTaskCardRenderResult,
  type SlackLiveTaskCardRenderStatus,
} from '@roomote/slack';
import { db, eq, taskRuns } from '@roomote/db/server';
import { getCommunicationProviderFromTaskPayload } from '@roomote/types';

import { renderTelegramLiveTaskStream } from '../telegram-live-task-stream';

/**
 * Render a run's provider-native live task surface on the worker's behalf.
 * The legacy name remains for worker/API compatibility. Surface pointers live
 * in control-plane Redis and provider credentials never leave the control
 * plane: sandboxed workers only send the state they want shown.
 *
 * The card title tracks the task's generated title once one exists (the
 * launcher only had the raw prompt when it posted the card).
 */
export async function renderSlackLiveTaskCardForRun(
  runId: number,
  input: {
    status: SlackLiveTaskCardRenderStatus;
    details?: string;
    output?: string;
  },
): Promise<SlackLiveTaskCardRenderResult> {
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { taskId: true, payload: true },
    with: { task: { columns: { title: true } } },
  });
  if (!run) {
    return { card: false, updated: false };
  }

  if (getCommunicationProviderFromTaskPayload(run.payload) === 'telegram') {
    return renderTelegramLiveTaskStream({
      taskId: run.taskId,
      status: input.status,
      ...(input.details ? { details: input.details } : {}),
      ...(input.output ? { output: input.output } : {}),
    });
  }

  const [rendered, codeChannelSync] = await Promise.all([
    renderSlackLiveTaskCard({
      taskId: run.taskId,
      status: input.status,
      ...(input.details ? { details: input.details } : {}),
      ...(input.output ? { output: input.output } : {}),
      taskTitle: run.task?.title,
    }),
    syncSlackCodeChannelForTask({
      taskId: run.taskId,
      status: input.status,
    }).catch(() => ({ codeChannel: false })),
  ]);
  return codeChannelSync.codeChannel
    ? { ...rendered, codeChannel: true }
    : rendered;
}

/**
 * The sandbox's branch diff for a task's Slack code channel (its Code tab).
 * Credentials stay in the control plane; the worker only sends the diff text.
 */
export async function publishSlackCodeChannelDiffForRun(
  runId: number,
  input: { diff: string; baseBranch?: string; headBranch?: string },
): Promise<{ codeChannel: boolean }> {
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { taskId: true },
  });
  if (!run) return { codeChannel: false };

  return syncSlackCodeChannelForTask({
    taskId: run.taskId,
    ...(input.headBranch ? { headBranch: input.headBranch } : {}),
    diff: {
      content: input.diff,
      ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
      ...(input.headBranch ? { headBranch: input.headBranch } : {}),
    },
  });
}
