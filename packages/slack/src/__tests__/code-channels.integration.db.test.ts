import {
  db,
  eq,
  slackInstallationFactory,
  slackInstallations,
  taskFactory,
  taskPullRequests,
  userFactory,
} from '@roomote/db/server';

import { syncSlackCodeChannelForTask } from '../code-channel-sync';
import {
  bindTaskToSlackCodeChannel,
  findSlackCodeChannel,
  openSlackCodeChannel,
  wrapUpSlackCodeChannel,
} from '../code-channels';
import { MockSlackServer, type MockSlackState } from '../mock-slack-server';
import { SlackNotifier } from '../slack-notifier';

const BOT_TOKEN = 'xoxb-mock-token';

describe('Slack code channels over HTTP (mock Slack + database)', () => {
  let server: MockSlackServer;
  let slack: SlackNotifier;
  let teamId: string;
  let installationId: string;

  beforeEach(async () => {
    teamId = `TCODEHTTP${Date.now()}${Math.floor(Math.random() * 1_000)}`;
    server = new MockSlackServer({
      state: {
        team: { id: teamId, domain: 'mock-roomote' },
        acceptedBotTokens: [BOT_TOKEN],
        channels: [{ id: 'CORIGIN', name: 'eng', isMember: true }],
        users: [],
        messages: [
          {
            channel: 'CORIGIN',
            ts: '100.002',
            text: '<@BROOMOTE> fix the flaky login test',
            user: 'UASKER',
            type: 'message',
            reactions: [],
          },
        ],
      },
    });
    await server.start();
    vi.stubEnv('SLACK_API_BASE_URL', `${server.baseUrl}/api/`);
    slack = new SlackNotifier(BOT_TOKEN);

    const user = await userFactory.create();
    const installation = await slackInstallationFactory.create({
      teamId,
      installedByUserId: user.id,
      botAccessToken: BOT_TOKEN,
    });
    installationId = installation.id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.stop();
    // Cascades to the code channels this installation opened.
    await db
      .delete(slackInstallations)
      .where(eq(slackInstallations.id, installationId));
  });

  async function readState() {
    const response = await fetch(`${server.baseUrl}/mock/state`);
    return (await response.json()) as MockSlackState;
  }

  it('runs a task session at the top level of its code channel, end to end', async () => {
    const opened = await openSlackCodeChannel({
      slack,
      slackInstallationId: installationId,
      teamId,
      originChannelId: 'CORIGIN',
      originMessageTs: '100.002',
      prompt: 'Fix the flaky login test',
      requesterUserId: 'UASKER',
    });
    expect(opened).not.toBeNull();
    const { channelId, anchorTs } = opened!;

    let state = await readState();
    expect(state.codeChannels?.[0]).toMatchObject({
      id: channelId,
      originChannelId: 'CORIGIN',
      originMessageTs: '100.002',
      commands: [expect.objectContaining({ name: 'wrap-up' })],
    });

    // Replies, streams and status aimed at the session go top-level.
    await slack.postMessage({
      channel: channelId,
      thread_ts: anchorTs,
      text: 'Looking at the login test now.',
    });
    await slack.startMessageStream({
      channel: channelId,
      threadTs: anchorTs,
      recipientTeamId: teamId,
      recipientUserId: 'UASKER',
      markdownText: 'Found it',
    });
    state = await readState();
    const channelMessages = (state.messages ?? []).filter(
      (message) => message.channel === channelId,
    );
    expect(channelMessages).toHaveLength(3);
    expect(channelMessages.every((message) => !message.thread_ts)).toBe(true);

    // Reading the session "thread" returns the channel from the anchor on.
    const session = await slack.fetchThreadMessages({
      channel: channelId,
      threadTs: anchorTs,
    });
    expect(session.map((message) => message.text)).toEqual([
      '<@UASKER> asked:\n> Fix the flaky login test',
      'Looking at the login test now.',
      'Found it',
    ]);

    // Status, context bar and diff follow the task.
    const task = await taskFactory.create({
      title: 'Fix the flaky login test',
    });
    await bindTaskToSlackCodeChannel({
      channelId,
      anchorTs,
      taskId: task.id,
      teamId,
    });
    await db.insert(taskPullRequests).values({
      taskId: task.id,
      prUrl: 'https://github.com/acme/web/pull/42',
      prNumber: 42,
      repository: 'acme/web',
    });
    await expect(
      syncSlackCodeChannelForTask({
        taskId: task.id,
        status: 'in_progress',
        diff: {
          content:
            'diff --git a/login.ts b/login.ts\n--- a/login.ts\n+++ b/login.ts\n@@ -1 +1 @@\n-a\n+b\n',
          baseBranch: 'main',
          headBranch: 'agent/fix-login',
        },
      }),
    ).resolves.toEqual({ codeChannel: true });

    state = await readState();
    expect(
      state.agentSessions?.find((entry) => entry.channel === channelId),
    ).toMatchObject({ threadTs: '', status: 'processing' });
    expect(state.codeChannels?.[0]?.contextBarItems).toEqual([
      {
        key: 'repo',
        label: 'acme/web',
        icon: 'folder',
        url: 'https://github.com/acme/web',
      },
      {
        key: 'branch',
        label: 'agent/fix-login',
        icon: 'branch',
        url: 'https://github.com/acme/web/tree/agent/fix-login',
      },
      {
        key: 'pr',
        label: 'PR #42',
        icon: 'hierarchy',
        url: 'https://github.com/acme/web/pull/42',
      },
    ]);
    expect(state.codeChannels?.[0]?.views).toEqual([
      expect.objectContaining({
        type: 'diff',
        base_branch: 'main',
        head_branch: 'agent/fix-login',
      }),
    ]);

    // A later task started inside the channel follows it too.
    const followUpTask = await taskFactory.create({
      title: 'Also cover the retry path',
    });
    await bindTaskToSlackCodeChannel({
      channelId,
      anchorTs,
      taskId: followUpTask.id,
      teamId,
    });
    await expect(
      syncSlackCodeChannelForTask({
        taskId: followUpTask.id,
        status: 'complete',
      }),
    ).resolves.toEqual({ codeChannel: true });
    state = await readState();
    expect(
      state.agentSessions?.find((entry) => entry.channel === channelId),
    ).toMatchObject({ status: 'active' });

    // /wrap-up posts the summary and archives with it.
    const row = await findSlackCodeChannel({ teamId, channelId });
    await expect(
      wrapUpSlackCodeChannel({ slack, channel: row! }),
    ).resolves.toEqual({ ok: true });
    state = await readState();
    const summary = (state.messages ?? []).at(-1);
    expect(summary).toMatchObject({ channel: channelId });
    // The summary names the channel's latest task and its PR.
    expect(summary?.text).toContain('Also cover the retry path');
    expect(summary?.text).toContain('PR #42');
    expect(state.codeChannels?.[0]).toMatchObject({
      archived: true,
      summaryMessageTs: summary?.ts,
    });

    // A task in an archived channel no longer syncs.
    await expect(
      syncSlackCodeChannelForTask({ taskId: task.id, status: 'complete' }),
    ).resolves.toEqual({ codeChannel: false });
  });
});
