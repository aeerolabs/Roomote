import {
  findSlackCodeChannel,
  SlackNotifier,
  wrapUpSlackCodeChannel,
} from '@roomote/slack';
import {
  and,
  db,
  eq,
  resolveSlackSigningSecret,
  slackInstallations,
} from '@roomote/db/server';

import { apiLogger } from '../../logging.js';
import { lookupSlackUserMapping } from './helpers/user-mapping.js';
import { verifySlackRequest } from './verifySlackRequest.js';

/**
 * Agent slash commands registered per code channel
 * (agents.conversations.setCommands). Slack posts them, signed like any
 * slash command, to features.code_channels.slash_command_url.
 * https://docs.slack.dev/ai/slack-code/agent-slash-commands
 */
export type SlackCodeChannelCommandResult = {
  status: number;
  body: Record<string, unknown>;
};

const ephemeral = (text: string): SlackCodeChannelCommandResult => ({
  status: 200,
  body: { response_type: 'ephemeral', text },
});

export async function handleSlackCodeChannelCommandRequest(params: {
  headers: Record<string, string | undefined>;
  rawBody: string;
}): Promise<SlackCodeChannelCommandResult> {
  const signingSecret = await resolveSlackSigningSecret();
  if (!signingSecret) {
    return {
      status: 503,
      body: { error: 'slack_signing_secret_not_configured' },
    };
  }
  const verification = verifySlackRequest(
    params.headers['x-slack-signature'],
    params.headers['x-slack-request-timestamp'],
    params.rawBody,
    signingSecret,
  );
  if (!verification.isValid) {
    apiLogger.warn(
      `[SlackCodeChannels] Command request verification failed: ${verification.error}`,
    );
    return { status: 401, body: {} };
  }

  const form = new URLSearchParams(params.rawBody);
  const teamId = form.get('team_id') ?? '';
  const channelId = form.get('channel_id') ?? '';
  const userId = form.get('user_id') ?? '';
  const command = (form.get('command') ?? '').replace(/^\//, '');
  if (!teamId || !channelId || !userId) {
    return ephemeral('That command is missing its channel or user.');
  }

  const codeChannel = await findSlackCodeChannel({ teamId, channelId });
  if (!codeChannel || codeChannel.archivedAt) {
    return ephemeral('This is not an open Roomote code channel.');
  }

  const { activeMapping } = await lookupSlackUserMapping({
    slackUserId: userId,
    teamId,
  });
  if (!activeMapping) {
    return ephemeral('Link your Slack account to Roomote to use this command.');
  }

  const installation = await db.query.slackInstallations.findFirst({
    where: and(
      eq(slackInstallations.id, codeChannel.slackInstallationId),
      eq(slackInstallations.isActive, true),
    ),
    columns: { botAccessToken: true },
  });
  if (!installation?.botAccessToken) {
    return ephemeral('Roomote is no longer installed in this workspace.');
  }

  switch (command) {
    case 'wrap-up': {
      // Slack expects an answer within 3 seconds; archiving can take longer.
      void wrapUpSlackCodeChannel({
        slack: new SlackNotifier(installation.botAccessToken),
        channel: codeChannel,
      })
        .then((result) => {
          if (!result.ok) {
            apiLogger.warn(
              `[SlackCodeChannels] Wrap-up failed for ${channelId}: ${result.error ?? 'unknown error'}`,
            );
          }
        })
        .catch((error) => {
          apiLogger.error(
            `[SlackCodeChannels] Wrap-up failed for ${channelId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return { status: 200, body: {} };
    }
    default:
      return ephemeral(`Unknown command /${command}.`);
  }
}
