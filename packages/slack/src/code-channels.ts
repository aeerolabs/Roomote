import { randomUUID } from 'node:crypto';

import {
  and,
  db,
  desc,
  eq,
  isNull,
  slackCodeChannels,
  taskPullRequests,
  tasks,
} from '@roomote/db/server';

import {
  forgetSlackCodeChannelAnchor,
  rememberSlackCodeChannelAnchor,
  setSlackCodeChannelAnchorResolver,
} from './code-channel-routing';
import type { SlackNotifier } from './slack-notifier';

/**
 * Slack code channels (https://docs.slack.dev/ai/slack-code/): when Roomote
 * starts a coding task from a Slack message, it can open a dedicated channel
 * for that task instead of working in the thread. The channel carries the
 * session status, a context bar (repo, branch, PR, preview), a Code tab with
 * the diff, and is archived with a summary when the work is done.
 *
 * The rest of Roomote keys Slack conversations on (channel, thread_ts), so a
 * code channel session runs as the "thread" of an anchor message: the kickoff
 * message Roomote posts first in the channel. code-channel-routing.ts
 * translates at the Slack edge.
 */

export const SLACK_CODE_CHANNELS_SCOPE = 'code_channels:manage';

/** Per-channel agent slash commands (agents.conversations.setCommands). */
export const SLACK_CODE_CHANNEL_COMMANDS = [
  {
    name: 'wrap-up',
    description: 'Post a summary and archive this channel',
  },
] as const;

export type SlackCodeChannel = typeof slackCodeChannels.$inferSelect;

/** Code channels are used only once the installation has granted the scope,
 * which happens after the app manifest is updated and the app reinstalled. */
export function slackInstallationHasCodeChannels(installation: {
  scopes: unknown;
}): boolean {
  const scopes = installation.scopes as { bot?: unknown } | null | undefined;
  return (
    Array.isArray(scopes?.bot) && scopes.bot.includes(SLACK_CODE_CHANNELS_SCOPE)
  );
}

async function findAnchorByChannel(channelId: string): Promise<string | null> {
  const [row] = await db
    .select({ anchorTs: slackCodeChannels.anchorTs })
    .from(slackCodeChannels)
    .where(eq(slackCodeChannels.channelId, channelId))
    .limit(1);
  return row?.anchorTs ?? null;
}

// Every server process that talks to Slack imports this package's index, so
// registering here gives each of them the database-backed lookup.
setSlackCodeChannelAnchorResolver(findAnchorByChannel);

export async function findSlackCodeChannel(params: {
  teamId: string;
  channelId: string;
}): Promise<SlackCodeChannel | null> {
  const [row] = await db
    .select()
    .from(slackCodeChannels)
    .where(
      and(
        eq(slackCodeChannels.teamId, params.teamId),
        eq(slackCodeChannels.channelId, params.channelId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findSlackCodeChannelForTask(
  taskId: string,
): Promise<SlackCodeChannel | null> {
  const [row] = await db
    .select()
    .from(slackCodeChannels)
    .where(eq(slackCodeChannels.taskId, taskId))
    .limit(1);
  return row ?? null;
}

function buildKickoffMarkdown(prompt: string, requesterUserId?: string) {
  const request = prompt.trim().replace(/\s+\n/g, '\n');
  const quoted = (
    request.length > 1_500 ? `${request.slice(0, 1_500)}…` : request
  )
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const asker = requesterUserId ? `<@${requesterUserId}> asked:` : 'The task:';
  return `${asker}\n${quoted}`;
}

/**
 * Opens a code channel for a task started from (originChannelId,
 * originMessageTs) and posts its anchor message. Returns null when Slack
 * refuses (feature not enabled, missing scope, Slack Connect origin, ...);
 * the caller then keeps the ordinary thread experience.
 */
export async function openSlackCodeChannel(params: {
  slack: Pick<
    SlackNotifier,
    | 'createCodeChannel'
    | 'postMessageDetailed'
    | 'archiveCodeChannel'
    | 'setCodeChannelCommands'
  >;
  slackInstallationId: string;
  teamId: string;
  originChannelId: string;
  originMessageTs: string;
  prompt: string;
  requesterUserId?: string;
}): Promise<{ channelId: string; anchorTs: string } | null> {
  const sessionId = `roomote-${randomUUID()}`;
  const created = await params.slack.createCodeChannel({
    sessionId,
    originChannelId: params.originChannelId,
    originMessageTs: params.originMessageTs,
  });
  if (!created.ok) {
    console.info(
      `[SlackCodeChannels] Staying in the thread: agents.conversations.create returned ${created.error}`,
    );
    return null;
  }

  const kickoff = buildKickoffMarkdown(params.prompt, params.requesterUserId);
  const posted = await params.slack.postMessageDetailed({
    channel: created.channelId,
    text: kickoff,
    blocks: [{ type: 'markdown', text: kickoff }],
    unfurl_links: false,
    unfurl_media: false,
  });
  if (!posted.ts) {
    console.warn(
      `[SlackCodeChannels] Could not post the anchor message in ${created.channelId}; archiving it and staying in the thread.`,
    );
    await params.slack.archiveCodeChannel({ channelId: created.channelId });
    return null;
  }

  await db
    .insert(slackCodeChannels)
    .values({
      slackInstallationId: params.slackInstallationId,
      teamId: params.teamId,
      channelId: created.channelId,
      sessionId,
      anchorTs: posted.ts,
      originChannelId: params.originChannelId,
      originMessageTs: params.originMessageTs,
    })
    .onConflictDoNothing();

  // Read back: a concurrent retry with the same channel keeps the first anchor.
  const stored = await findSlackCodeChannel({
    teamId: params.teamId,
    channelId: created.channelId,
  });
  const anchorTs = stored?.anchorTs ?? posted.ts;
  rememberSlackCodeChannelAnchor(created.channelId, anchorTs);
  // Best effort: without a slash_command_url Slack rejects the registration
  // and the channel simply has no agent commands.
  await params.slack.setCodeChannelCommands({
    channelId: created.channelId,
    commands: [...SLACK_CODE_CHANNEL_COMMANDS],
  });
  return { channelId: created.channelId, anchorTs };
}

/**
 * Binds a task to its code channel so follow-ups in the channel reach the
 * task (the thread lookups read tasks.slack_channel_id / slack_thread_ts).
 */
export async function bindTaskToSlackCodeChannel(params: {
  channelId: string;
  anchorTs: string;
  taskId: string;
  teamId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(slackCodeChannels)
      .set({ taskId: params.taskId, updatedAt: new Date() })
      .where(
        and(
          eq(slackCodeChannels.teamId, params.teamId),
          eq(slackCodeChannels.channelId, params.channelId),
          isNull(slackCodeChannels.taskId),
        ),
      );
    await tx
      .update(tasks)
      .set({
        slackChannelId: params.channelId,
        slackThreadTs: params.anchorTs,
      })
      .where(eq(tasks.id, params.taskId));
  });
}

export async function markSlackCodeChannelArchived(params: {
  teamId: string;
  channelId: string;
}): Promise<void> {
  await db
    .update(slackCodeChannels)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(slackCodeChannels.teamId, params.teamId),
        eq(slackCodeChannels.channelId, params.channelId),
      ),
    );
  forgetSlackCodeChannelAnchor(params.channelId);
}

function buildWrapUpSummary(params: {
  title: string | null;
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
}): string {
  const lines = [
    params.title ? `**Wrapped up:** ${params.title}` : '**Wrapped up.**',
  ];
  if (params.pullRequestUrl) {
    const label = params.pullRequestNumber
      ? `PR #${params.pullRequestNumber}`
      : 'Pull request';
    lines.push(`[${label}](${params.pullRequestUrl})`);
  }
  lines.push('This channel is archived and stays searchable.');
  return lines.join('\n');
}

/**
 * /wrap-up in a code channel: post a summary, record it as the channel's
 * summary message and archive the channel.
 */
export async function wrapUpSlackCodeChannel(params: {
  slack: Pick<SlackNotifier, 'postMessageDetailed' | 'archiveCodeChannel'>;
  channel: SlackCodeChannel;
}): Promise<{ ok: boolean; error?: string }> {
  const { channel, slack } = params;

  // The channel's most recent task carries the work being wrapped up.
  const [task] = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(
      and(
        eq(tasks.slackChannelId, channel.channelId),
        eq(tasks.slackThreadTs, channel.anchorTs),
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  const [pullRequest] = await db
    .select({
      prUrl: taskPullRequests.prUrl,
      prNumber: taskPullRequests.prNumber,
    })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .where(
      and(
        eq(tasks.slackChannelId, channel.channelId),
        eq(tasks.slackThreadTs, channel.anchorTs),
      ),
    )
    .orderBy(desc(taskPullRequests.createdAt))
    .limit(1);

  const summary = buildWrapUpSummary({
    title: task?.title ?? null,
    pullRequestUrl: pullRequest?.prUrl ?? null,
    pullRequestNumber: pullRequest?.prNumber ?? null,
  });
  const posted = await slack.postMessageDetailed({
    channel: channel.channelId,
    text: summary,
    blocks: [{ type: 'markdown', text: summary }],
    unfurl_links: false,
    unfurl_media: false,
  });

  const archived = await slack.archiveCodeChannel({
    channelId: channel.channelId,
    ...(posted.ts ? { summaryMessageTs: posted.ts } : {}),
  });
  if (!archived.ok) {
    return { ok: false, ...(archived.error ? { error: archived.error } : {}) };
  }
  await markSlackCodeChannelArchived({
    teamId: channel.teamId,
    channelId: channel.channelId,
  });
  return { ok: true };
}
