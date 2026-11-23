import {
  createFastAgentSlackTaskLauncher,
  type FastAgentSlackTaskLauncherParams,
  type LaunchFastAgentTask,
} from '@roomote/cloud-agents/server';
import { buildSelectedTaskSessionUrl } from '@roomote/communication';
import { RunStatus } from '@roomote/types';
import { db, getSessionForTask } from '@roomote/db/server';
import {
  buildSlackLiveTaskCardBlocks,
  SLACK_SESSION_LIVE_TASK_CARD_MESSAGES,
} from './live-task-card-blocks';
import {
  buildSlackLiveTaskTitle,
  getSlackLiveTaskStreamData,
  setSlackLiveTaskStreamData,
} from './live-task-stream';
import type { SlackNotifier } from './slack-notifier';
import { settleSlackLiveTaskCardForRun } from './settle-live-task-card';
import { resolveSlackCodeChannelAnchor } from './code-channel-routing';
import {
  bindTaskToSlackCodeChannel,
  openSlackCodeChannel,
} from './code-channels';

type SlackLiveTaskCardNotifier = Pick<
  SlackNotifier,
  | 'normalizeIncomingText'
  | 'postMessage'
  | 'postMessageDetailed'
  | 'updateMessage'
  | 'createCodeChannel'
  | 'archiveCodeChannel'
>;

type SlackLaunchTarget = {
  channelId: string;
  threadTs: string;
  messageId?: string;
  /** Set when the task runs in a code channel Roomote just opened. */
  codeChannel?: { channelId: string; anchorTs: string };
};

const STARTING_TASK_TITLE = 'Starting task…';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fast delegation launcher that also posts a native task card (a
 * `task_card` block) in the parent thread. The card opens as a bare
 * "Starting task…" placeholder; once the sandbox is up the worker renders
 * the generated title and then re-renders the whole card through
 * chat.update for the task's lifetime, so it always shows the latest state.
 *
 * The kickoff message omits the task link because the card carries it, so
 * every failure path here must still leave a link in the thread: either the
 * card itself (flipped to an error state when it cannot be tracked) or a
 * plain link message.
 */
export function createFastAgentSlackLiveTaskLauncher(
  params: Omit<
    FastAgentSlackTaskLauncherParams,
    'liveTaskStream' | 'afterKickoff' | 'onQueueFailure' | 'rendersTaskLink'
  > & {
    slack: SlackLiveTaskCardNotifier;
    /** Present when the installation can open code channels: each task then
     * gets its own channel instead of running in the thread. */
    codeChannels?: {
      slackInstallationId: string;
      requesterSlackUserId?: string;
    };
  },
): LaunchFastAgentTask {
  const { slack, codeChannels, ...baseLauncherParams } = params;

  const resolveLaunchTarget = async (
    prompt: string,
  ): Promise<SlackLaunchTarget> => {
    const threadTarget: SlackLaunchTarget = {
      channelId: baseLauncherParams.channelId,
      threadTs: baseLauncherParams.threadTs,
      ...(baseLauncherParams.messageId
        ? { messageId: baseLauncherParams.messageId }
        : {}),
    };
    if (!codeChannels) return threadTarget;
    // Already inside a code channel: keep working there.
    if (await resolveSlackCodeChannelAnchor(baseLauncherParams.channelId)) {
      return threadTarget;
    }

    try {
      const opened = await openSlackCodeChannel({
        slack,
        slackInstallationId: codeChannels.slackInstallationId,
        teamId: baseLauncherParams.teamId,
        originChannelId: baseLauncherParams.channelId,
        originMessageTs:
          baseLauncherParams.messageId ?? baseLauncherParams.threadTs,
        prompt,
        ...(codeChannels.requesterSlackUserId
          ? { requesterUserId: codeChannels.requesterSlackUserId }
          : {}),
      });
      if (!opened) return threadTarget;
      return {
        channelId: opened.channelId,
        threadTs: opened.anchorTs,
        messageId: opened.anchorTs,
        codeChannel: opened,
      };
    } catch (error) {
      console.error(
        `[Fast Agent] Failed to open a Slack code channel; staying in the thread: ${describeError(error)}`,
      );
      return threadTarget;
    }
  };

  const buildLauncher = (target: SlackLaunchTarget): LaunchFastAgentTask => {
    const launcherParams = {
      ...baseLauncherParams,
      channelId: target.channelId,
      threadTs: target.threadTs,
      ...(target.messageId ? { messageId: target.messageId } : {}),
    };

    const postTaskLink = async (taskUrl: string): Promise<void> => {
      const label = 'Open in Roomote';
      try {
        await slack.postMessage({
          channel: launcherParams.channelId,
          thread_ts: launcherParams.threadTs,
          text: `${label}: ${taskUrl}`,
          blocks: [{ type: 'markdown', text: `[${label}](${taskUrl})` }],
          unfurl_links: false,
          unfurl_media: false,
        });
      } catch (error) {
        console.error(
          `[Fast Agent] Failed to post the task link fallback: ${describeError(error)}`,
        );
      }
    };

    const startLiveTaskCard = async (
      taskRun: { id: number; taskId: string },
      context: { prompt: string; taskUrl: string },
    ): Promise<void> => {
      const taskUpdateId = `roomote-task-${taskRun.taskId}`;
      let messageTs: string | undefined;
      let destinationUrl = context.taskUrl;

      try {
        const linkedSession = await getSessionForTask(db, taskRun.taskId);
        destinationUrl = linkedSession
          ? buildSelectedTaskSessionUrl({
              taskUrl: context.taskUrl,
              sessionId: linkedSession.id,
              taskId: taskRun.taskId,
            })
          : context.taskUrl;
        // A card for this task already exists (for example an idempotent
        // relaunch of the same task); keep updating it instead of posting
        // a second card in the thread.
        if (await getSlackLiveTaskStreamData(taskRun.taskId)) {
          return;
        }

        const posted = await slack.postMessageDetailed({
          channel: launcherParams.channelId,
          thread_ts: launcherParams.threadTs,
          ...buildSlackLiveTaskCardBlocks({
            taskUpdateId,
            title: STARTING_TASK_TITLE,
            status: 'in_progress',
            taskUrl: destinationUrl,
          }),
          unfurl_links: false,
          unfurl_media: false,
        });
        messageTs = posted.ts;

        if (!messageTs) {
          // The thread root is gone: nothing in this thread can be read any
          // more, so a link would be as invisible as the card.
          if (posted.skippedMissingThreadRoot) {
            return;
          }
          console.warn(
            `[Fast Agent] Slack rejected the task card for run ${taskRun.id} (${posted.slackErrorCode ?? (posted.transportError ? 'transport error' : 'unknown')}); posting the task link instead.`,
          );
          await postTaskLink(destinationUrl);
          return;
        }

        // The stored title is the prompt-derived fallback the worker renders
        // if no generated title exists yet.
        await setSlackLiveTaskStreamData(taskRun.taskId, {
          teamId: launcherParams.teamId,
          channel: launcherParams.channelId,
          messageTs,
          taskId: taskRun.taskId,
          taskUpdateId,
          threadTs: launcherParams.threadTs,
          title: buildSlackLiveTaskTitle(context.prompt),
          taskUrl: destinationUrl,
        });
      } catch (error) {
        console.error(
          `[Fast Agent] Failed to post the Slack task card for run ${taskRun.id}: ${describeError(error)}`,
        );

        if (!messageTs) {
          await postTaskLink(destinationUrl);
          return;
        }

        // The card was posted but its pointer was not recorded, so no worker
        // will ever update it. Settle it now rather than leave it spinning;
        // it still carries the task link.
        let settled = false;
        try {
          settled = await slack.updateMessage({
            channel: launcherParams.channelId,
            ts: messageTs,
            message: buildSlackLiveTaskCardBlocks({
              taskUpdateId,
              title: STARTING_TASK_TITLE,
              status: 'error',
              output: SLACK_SESSION_LIVE_TASK_CARD_MESSAGES.trackingUnavailable,
              taskUrl: destinationUrl,
            }),
          });
        } catch (updateError) {
          console.error(
            `[Fast Agent] Failed to settle the untracked task card for run ${taskRun.id}: ${describeError(updateError)}`,
          );
        }
        if (!settled) {
          await postTaskLink(destinationUrl);
        }
      }
    };

    return createFastAgentSlackTaskLauncher({
      ...launcherParams,
      liveTaskStream: true,
      afterKickoff: async (taskRun, context) => {
        if (target.codeChannel) {
          await bindTaskToSlackCodeChannel({
            ...target.codeChannel,
            taskId: taskRun.taskId,
            teamId: launcherParams.teamId,
          });
        }
        await startLiveTaskCard(taskRun, context);
      },
      onQueueFailure: async (taskRun) => {
        await settleSlackLiveTaskCardForRun({
          taskId: taskRun.taskId,
          payload: { liveTaskStream: true },
          status: RunStatus.Canceled,
        });
      },
      rendersTaskLink: true,
    });
  };

  return async (input) => {
    const prompt = await slack
      .normalizeIncomingText(input.prompt, { preserveMentions: true })
      .catch((error) => {
        console.warn(
          `[Fast Agent] Failed to normalize the Slack task prompt: ${describeError(error)}`,
        );
        return input.prompt;
      });

    const target = await resolveLaunchTarget(prompt);
    return buildLauncher(target)({ ...input, prompt });
  };
}
