import { createHash } from 'node:crypto';

import { resolveThreadReplyLivePreviewUrl } from '@roomote/communication';
import {
  and,
  db,
  desc,
  eq,
  isNull,
  slackCodeChannels,
  slackInstallations,
  taskPullRequests,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { ALL_REPOSITORIES, NO_REPOSITORIES } from '@roomote/types';

import {
  SlackNotifier,
  type SlackCodeChannelContextBarItem,
} from './slack-notifier';

/** Slack rejects diff views over 1,000,000 bytes (content_too_large). */
export const SLACK_CODE_CHANNEL_DIFF_MAX_BYTES = 990_000;

type CodeChannelTurnStatus = 'in_progress' | 'complete' | 'error';

const SESSION_STATUS_BY_TURN: Record<
  CodeChannelTurnStatus,
  'processing' | 'active'
> = {
  in_progress: 'processing',
  complete: 'active',
  error: 'active',
};

/** Repository web URL from a PR/MR URL on any supported provider. */
function repositoryUrlFromPullRequestUrl(prUrl: string): string | null {
  const markers = [
    '/pull/',
    '/-/merge_requests/',
    '/pulls/',
    '/pullrequest/',
    '/pull-requests/',
  ];
  for (const marker of markers) {
    const index = prUrl.indexOf(marker);
    if (index > 0) return prUrl.slice(0, index);
  }
  return null;
}

async function buildContextBarItems(params: {
  taskId: string;
  headBranch: string | null;
}): Promise<SlackCodeChannelContextBarItem[]> {
  const [pullRequest] = await db
    .select({
      prUrl: taskPullRequests.prUrl,
      prNumber: taskPullRequests.prNumber,
      repository: taskPullRequests.repository,
    })
    .from(taskPullRequests)
    .where(eq(taskPullRequests.taskId, params.taskId))
    .orderBy(desc(taskPullRequests.createdAt))
    .limit(1);

  const [run] = await db
    .select({ payload: taskRuns.payload })
    .from(taskRuns)
    .where(eq(taskRuns.taskId, params.taskId))
    .orderBy(desc(taskRuns.createdAt), desc(taskRuns.id))
    .limit(1);
  const payloadRepo = (run?.payload as { repo?: unknown } | null)?.repo;

  const items: SlackCodeChannelContextBarItem[] = [];
  const repository =
    pullRequest?.repository ??
    (typeof payloadRepo === 'string' &&
    payloadRepo !== ALL_REPOSITORIES &&
    payloadRepo !== NO_REPOSITORIES
      ? payloadRepo
      : null);
  const repositoryUrl = pullRequest
    ? repositoryUrlFromPullRequestUrl(pullRequest.prUrl)
    : null;
  if (repository) {
    items.push({
      key: 'repo',
      label: repository,
      icon: 'folder',
      ...(repositoryUrl ? { url: repositoryUrl } : {}),
    });
  }
  if (params.headBranch) {
    items.push({
      key: 'branch',
      label: params.headBranch,
      icon: 'branch',
      ...(repositoryUrl
        ? {
            url: `${repositoryUrl}/tree/${params.headBranch
              .split('/')
              .map(encodeURIComponent)
              .join('/')}`,
          }
        : {}),
    });
  }
  if (pullRequest) {
    items.push({
      key: 'pr',
      label: pullRequest.prNumber
        ? `PR #${pullRequest.prNumber}`
        : 'Pull request',
      icon: 'hierarchy',
      url: pullRequest.prUrl,
    });
  }
  const previewUrl = await resolveThreadReplyLivePreviewUrl(params.taskId);
  if (previewUrl) {
    items.push({
      key: 'preview',
      label: 'Preview',
      icon: 'globe',
      url: previewUrl,
    });
  }
  return items;
}

/** Cuts a unified diff at a file boundary so it fits Slack's view limit. */
export function fitDiffForSlack(diff: string): string {
  if (Buffer.byteLength(diff, 'utf8') <= SLACK_CODE_CHANNEL_DIFF_MAX_BYTES) {
    return diff;
  }
  const files = diff.split(/(?=^diff --git )/m);
  let fitted = '';
  for (const file of files) {
    if (
      Buffer.byteLength(fitted + file, 'utf8') >
      SLACK_CODE_CHANNEL_DIFF_MAX_BYTES
    ) {
      break;
    }
    fitted += file;
  }
  return fitted;
}

/**
 * Keeps a task's code channel in step with the task: session status, the
 * context bar (repo, branch, PR, preview) and, when the sandbox sends one,
 * the diff in the Code tab. Best effort and idempotent; returns whether the
 * task has a code channel at all so the sandbox knows to send diffs.
 */
export async function syncSlackCodeChannelForTask(params: {
  taskId: string;
  status?: CodeChannelTurnStatus;
  headBranch?: string;
  diff?: { content: string; baseBranch?: string; headBranch?: string };
}): Promise<{ codeChannel: boolean }> {
  const [row] = await db
    .select({
      channel: slackCodeChannels,
      botAccessToken: slackInstallations.botAccessToken,
    })
    .from(slackCodeChannels)
    .innerJoin(
      slackInstallations,
      eq(slackInstallations.id, slackCodeChannels.slackInstallationId),
    )
    // Every task launched in the channel is bound to it through its Slack
    // channel and thread, not only the task that opened it.
    .innerJoin(
      tasks,
      and(
        eq(tasks.slackChannelId, slackCodeChannels.channelId),
        eq(tasks.slackThreadTs, slackCodeChannels.anchorTs),
      ),
    )
    .where(
      and(
        eq(tasks.id, params.taskId),
        isNull(slackCodeChannels.archivedAt),
        eq(slackInstallations.isActive, true),
      ),
    )
    .limit(1);
  if (!row) return { codeChannel: false };

  const { channel } = row;
  const slack = new SlackNotifier(row.botAccessToken);
  const updates: Partial<typeof slackCodeChannels.$inferInsert> = {};

  try {
    const sessionStatus = params.status
      ? SESSION_STATUS_BY_TURN[params.status]
      : undefined;
    if (sessionStatus && sessionStatus !== channel.lastSessionStatus) {
      const result = await slack.setAgentSessionStatus({
        channel: channel.channelId,
        threadTs: channel.anchorTs,
        status: sessionStatus,
      });
      if (result.ok) updates.lastSessionStatus = sessionStatus;
    }

    const headBranch =
      params.headBranch ?? params.diff?.headBranch ?? channel.headBranch;
    if (headBranch && headBranch !== channel.headBranch) {
      updates.headBranch = headBranch;
    }

    const items = await buildContextBarItems({
      taskId: params.taskId,
      headBranch: headBranch ?? null,
    });
    const contextBarHash = createHash('sha256')
      .update(JSON.stringify(items))
      .digest('hex');
    if (items.length > 0 && contextBarHash !== channel.contextBarHash) {
      if (
        await slack.setCodeChannelContextBar({
          channelId: channel.channelId,
          items,
        })
      ) {
        updates.contextBarHash = contextBarHash;
      }
    }

    const diff = params.diff ? fitDiffForSlack(params.diff.content) : '';
    if (diff.trim()) {
      await slack.setCodeChannelDiff({
        channelId: channel.channelId,
        diff,
        ...(params.diff?.baseBranch
          ? { baseBranch: params.diff.baseBranch }
          : {}),
        ...(headBranch ? { headBranch } : {}),
      });
    }
  } catch (error) {
    console.warn(
      `[SlackCodeChannels] Sync failed for task ${params.taskId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (Object.keys(updates).length > 0) {
    await db
      .update(slackCodeChannels)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(slackCodeChannels.id, channel.id));
  }
  return { codeChannel: true };
}
