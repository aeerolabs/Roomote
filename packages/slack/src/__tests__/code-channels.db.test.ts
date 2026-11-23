import {
  db,
  eq,
  slackCodeChannels,
  slackInstallationFactory,
  taskFactory,
  tasks,
  userFactory,
} from '@roomote/db/server';

import { resolveSlackCodeChannelAnchor } from '../code-channel-routing';
import {
  bindTaskToSlackCodeChannel,
  findSlackCodeChannel,
  openSlackCodeChannel,
  slackInstallationHasCodeChannels,
  wrapUpSlackCodeChannel,
} from '../code-channels';

function fakeSlack(channelId = `CCODE${Date.now()}`) {
  return {
    createCodeChannel: vi.fn().mockResolvedValue({ ok: true, channelId }),
    postMessageDetailed: vi.fn().mockResolvedValue({ ts: '200.001' }),
    archiveCodeChannel: vi.fn().mockResolvedValue({ ok: true }),
    setCodeChannelCommands: vi.fn().mockResolvedValue(true),
  };
}

describe('Slack code channels (database)', () => {
  let installationId: string;
  let teamId: string;

  beforeEach(async () => {
    const user = await userFactory.create();
    teamId = `TCODE${Date.now()}${Math.floor(Math.random() * 1_000)}`;
    const installation = await slackInstallationFactory.create({
      teamId,
      installedByUserId: user.id,
    });
    installationId = installation.id;
  });

  it('gates on the code_channels:manage bot scope', () => {
    expect(
      slackInstallationHasCodeChannels({
        scopes: { bot: ['chat:write', 'code_channels:manage'] },
      }),
    ).toBe(true);
    expect(
      slackInstallationHasCodeChannels({ scopes: { bot: ['chat:write'] } }),
    ).toBe(false);
    expect(slackInstallationHasCodeChannels({ scopes: null })).toBe(false);
  });

  it('opens a channel, binds its task, and wraps it up', async () => {
    const slack = fakeSlack();
    const opened = await openSlackCodeChannel({
      slack,
      slackInstallationId: installationId,
      teamId,
      originChannelId: 'CORIGIN',
      originMessageTs: '100.002',
      prompt: 'Fix the flaky login test',
      requesterUserId: 'U1',
    });

    expect(opened).not.toBeNull();
    const channelId = opened!.channelId;
    expect(slack.createCodeChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        originChannelId: 'CORIGIN',
        originMessageTs: '100.002',
      }),
    );
    // The anchor is a top-level kickoff post quoting the request.
    expect(slack.postMessageDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: channelId,
        text: '<@U1> asked:\n> Fix the flaky login test',
      }),
    );
    expect(slack.postMessageDetailed.mock.calls[0]?.[0]).not.toHaveProperty(
      'thread_ts',
    );
    expect(slack.setCodeChannelCommands).toHaveBeenCalledWith({
      channelId,
      commands: [expect.objectContaining({ name: 'wrap-up' })],
    });
    await expect(resolveSlackCodeChannelAnchor(channelId)).resolves.toBe(
      '200.001',
    );

    const task = await taskFactory.create({
      title: 'Fix the flaky login test',
    });
    await bindTaskToSlackCodeChannel({
      channelId,
      anchorTs: '200.001',
      taskId: task.id,
      teamId,
    });
    const [boundTask] = await db
      .select({
        slackChannelId: tasks.slackChannelId,
        slackThreadTs: tasks.slackThreadTs,
      })
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(boundTask).toEqual({
      slackChannelId: channelId,
      slackThreadTs: '200.001',
    });

    const row = await findSlackCodeChannel({ teamId, channelId });
    expect(row?.taskId).toBe(task.id);

    slack.postMessageDetailed.mockResolvedValue({ ts: '200.050' });
    await expect(
      wrapUpSlackCodeChannel({ slack, channel: row! }),
    ).resolves.toEqual({ ok: true });
    expect(slack.archiveCodeChannel).toHaveBeenCalledWith({
      channelId,
      summaryMessageTs: '200.050',
    });
    const [archived] = await db
      .select({ archivedAt: slackCodeChannels.archivedAt })
      .from(slackCodeChannels)
      .where(eq(slackCodeChannels.channelId, channelId));
    expect(archived?.archivedAt).toBeInstanceOf(Date);
  });

  it('stays in the thread when Slack refuses to open a channel', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const slack = fakeSlack();
    slack.createCodeChannel.mockResolvedValue({
      ok: false,
      error: 'feature_disabled',
    });

    await expect(
      openSlackCodeChannel({
        slack,
        slackInstallationId: installationId,
        teamId,
        originChannelId: 'CORIGIN',
        originMessageTs: '100.002',
        prompt: 'Fix it',
      }),
    ).resolves.toBeNull();
    expect(slack.postMessageDetailed).not.toHaveBeenCalled();
  });

  it('archives the new channel when the anchor message cannot be posted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slack = fakeSlack();
    slack.postMessageDetailed.mockResolvedValue({
      slackErrorCode: 'not_in_channel',
    });

    await expect(
      openSlackCodeChannel({
        slack,
        slackInstallationId: installationId,
        teamId,
        originChannelId: 'CORIGIN',
        originMessageTs: '100.002',
        prompt: 'Fix it',
      }),
    ).resolves.toBeNull();
    expect(slack.archiveCodeChannel).toHaveBeenCalled();
  });
});
