import { activeRunStatuses } from '@roomote/types';
import { and, db, eq, inArray, isNull, taskRuns } from '@roomote/db/server';
import {
  findActiveSlackTaskRun,
  resolveSlackCodeChannelAnchor,
  type SlackAgentSessionStoppedEvent,
} from '@roomote/slack';
import { stopTaskRun } from '@roomote/sdk/server';

import { apiLogger } from '../../../logging.js';
import type { SlackWebhookContext } from '../context.js';
import { lookupSlackUserMapping } from '../helpers/user-mapping.js';

/**
 * The native stop button on an agent session (a session thread, or a whole
 * code channel). Slack stops any streaming message itself; Roomote stops the
 * task run and moves the session out of `processing`.
 * https://docs.slack.dev/reference/events/agent_session_stopped
 */
export async function handleAgentSessionStoppedEvent(params: {
  event: SlackAgentSessionStoppedEvent;
  context: SlackWebhookContext;
}): Promise<void> {
  const { event, context } = params;
  const threadTs =
    event.thread_ts ?? (await resolveSlackCodeChannelAnchor(event.channel));
  if (!threadTs) return;

  const settleSession = () =>
    context.slack.setAgentSessionStatus({
      channel: event.channel,
      threadTs,
      status: 'active',
    });

  const activeRun = await findActiveSlackTaskRun(threadTs, {
    slackTeamId: context.teamId,
  });
  if (!activeRun) {
    await settleSession();
    return;
  }

  const run = await db.query.taskRuns.findFirst({
    where: and(
      eq(taskRuns.id, activeRun.id),
      inArray(taskRuns.status, [...activeRunStatuses]),
      isNull(taskRuns.canceledAt),
    ),
    columns: {
      id: true,
      taskId: true,
      status: true,
      sandboxServerUrl: true,
      actingUserId: true,
      payload: true,
    },
    with: { task: { columns: { initiatorUserId: true } } },
  });
  if (!run) {
    await settleSession();
    return;
  }

  const { activeMapping } = await lookupSlackUserMapping({
    slackUserId: event.user,
    teamId: context.teamId,
  });
  const ownerUserId = run.task?.initiatorUserId ?? null;
  if (
    !activeMapping ||
    (activeMapping.userId !== run.actingUserId &&
      activeMapping.userId !== ownerUserId)
  ) {
    await context.slack.postEphemeralMessage({
      channel: event.channel,
      user: event.user,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      text: 'Only the person who started this task can stop it.',
    });
    return;
  }

  const result = await stopTaskRun({
    run,
    authUserId: activeMapping.userId,
    allowDirectCancelWithoutSandbox: true,
    terminate: true,
    cancelledBy: { source: 'slack' },
  });
  if (
    !result.success &&
    result.statusCode !== 404 &&
    result.statusCode !== 409
  ) {
    apiLogger.warn(
      `[SlackAgentSession] Stop failed for run ${run.id}: ${result.error ?? 'unknown error'}`,
    );
  }
  await settleSession();
}
