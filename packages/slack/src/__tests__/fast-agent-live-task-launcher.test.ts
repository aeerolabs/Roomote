const mocks = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
  getSessionForTask: vi.fn(),
  getSlackLiveTaskStreamData: vi.fn(),
  setSlackLiveTaskStreamData: vi.fn(),
  postMessage: vi.fn(),
  postMessageDetailed: vi.fn(),
  updateMessage: vi.fn(),
  normalizeIncomingText: vi.fn(async (text: string) => text),
  settleSlackLiveTaskCardForRun: vi.fn(),
  openSlackCodeChannel: vi.fn(),
  bindTaskToSlackCodeChannel: vi.fn(),
  resolveSlackCodeChannelAnchor: vi.fn(),
  taskUrl: 'https://roomote.example/task/task-1',
}));

// Contract-faithful stand-in for the cloud-agents launcher (hook ordering is
// covered by its own tests): kickoff, then afterKickoff inside the launch
// gate.
vi.mock('@roomote/cloud-agents/server', () => ({
  createFastAgentSlackTaskLauncher: (params: {
    liveTaskStream?: boolean;
    rendersTaskLink?: boolean;
    afterKickoff?: (
      taskRun: { id: number; taskId: string },
      context: { prompt: string; taskUrl: string },
    ) => Promise<void>;
    onQueueFailure?: (taskRun: { id: number; taskId: string }) => Promise<void>;
    [key: string]: unknown;
  }) => {
    const {
      liveTaskStream,
      afterKickoff,
      onQueueFailure,
      rendersTaskLink,
      ...rest
    } = params;
    return async (input: {
      prompt: string;
      environmentId: string | null;
      parentSessionId: string;
      postKickoff: (task: {
        taskId: string;
        taskUrl?: string;
      }) => Promise<void>;
    }) => {
      const taskUrl = mocks.taskUrl;
      await input.postKickoff({ taskId: 'task-1', taskUrl });
      await afterKickoff?.(
        { id: 42, taskId: 'task-1' },
        { prompt: input.prompt, taskUrl },
      );
      try {
        await mocks.enqueueTask({
          ...rest,
          liveTaskStream,
          rendersTaskLink,
          environmentId: input.environmentId,
        });
      } catch (error) {
        await onQueueFailure?.({ id: 42, taskId: 'task-1' });
        throw error;
      }
      return { success: true, taskId: 'task-1', taskUrl };
    };
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  getSessionForTask: mocks.getSessionForTask,
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://roomote.example' },
}));

vi.mock('../live-task-stream', () => ({
  buildSlackLiveTaskTitle: (prompt: string) => prompt,
  getSlackLiveTaskStreamData: mocks.getSlackLiveTaskStreamData,
  setSlackLiveTaskStreamData: mocks.setSlackLiveTaskStreamData,
}));

vi.mock('../settle-live-task-card', () => ({
  settleSlackLiveTaskCardForRun: mocks.settleSlackLiveTaskCardForRun,
}));

vi.mock('../code-channels', () => ({
  openSlackCodeChannel: mocks.openSlackCodeChannel,
  bindTaskToSlackCodeChannel: mocks.bindTaskToSlackCodeChannel,
}));

vi.mock('../code-channel-routing', () => ({
  resolveSlackCodeChannelAnchor: mocks.resolveSlackCodeChannelAnchor,
}));

import { RunStatus } from '@roomote/types';

import { createFastAgentSlackLiveTaskLauncher } from '../fast-agent-live-task-launcher';

function createLauncher(
  visibleInTranscript?: boolean,
  codeChannels?: { slackInstallationId: string; requesterSlackUserId?: string },
) {
  return createFastAgentSlackLiveTaskLauncher({
    slack: {
      postMessage: mocks.postMessage,
      postMessageDetailed: mocks.postMessageDetailed,
      updateMessage: mocks.updateMessage,
      normalizeIncomingText: mocks.normalizeIncomingText,
      createCodeChannel: vi.fn(),
      archiveCodeChannel: vi.fn(),
      setCodeChannelCommands: vi.fn(),
    },
    ...(codeChannels ? { codeChannels } : {}),
    userId: 'user-1',
    teamId: 'T123',
    teamDomain: 'acme',
    channelId: 'C123',
    threadTs: '100.001',
    messageId: '100.002',
    ...(visibleInTranscript !== undefined ? { visibleInTranscript } : {}),
  });
}

describe('createFastAgentSlackLiveTaskLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueTask.mockResolvedValue(undefined);
    mocks.getSessionForTask.mockResolvedValue(null);
    mocks.getSlackLiveTaskStreamData.mockResolvedValue(null);
    mocks.postMessageDetailed.mockResolvedValue({ ts: 'card-ts' });
    mocks.postMessage.mockResolvedValue('fallback-ts');
    mocks.normalizeIncomingText.mockImplementation(async (text: string) =>
      text.replace('<@U456>', '@Readable Name'),
    );
    mocks.setSlackLiveTaskStreamData.mockResolvedValue(undefined);
    mocks.updateMessage.mockResolvedValue(true);
    mocks.settleSlackLiveTaskCardForRun.mockResolvedValue(undefined);
    mocks.taskUrl = 'https://roomote.example/task/task-1';
    mocks.resolveSlackCodeChannelAnchor.mockResolvedValue(null);
    mocks.openSlackCodeChannel.mockResolvedValue(null);
    mocks.bindTaskToSlackCodeChannel.mockResolvedValue(undefined);
  });

  const taskLinkFallback = {
    channel: 'C123',
    thread_ts: '100.001',
    text: 'Open in Roomote: https://roomote.example/task/task-1',
    blocks: [
      {
        type: 'markdown',
        text: '[Open in Roomote](https://roomote.example/task/task-1)',
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };

  it('forwards explicit prompt visibility from the launch origin', async () => {
    const launchTask = createLauncher(true);

    await launchTask({
      prompt: '$review-code Check this change',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({ visibleInTranscript: true }),
    );
  });

  it('posts a starting placeholder card in the parent thread and records the task title', async () => {
    const launchTask = createLauncher();

    await expect(
      launchTask({
        prompt: 'Add a regression test',
        environmentId: 'env-1',
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        postKickoff: vi.fn(),
      }),
    ).resolves.toEqual({
      success: true,
      taskId: 'task-1',
      taskUrl: 'https://roomote.example/task/task-1',
    });

    expect(mocks.postMessageDetailed).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '100.001',
      text: 'Starting task…\n<https://roomote.example/task/task-1|Open in Roomote>',
      blocks: [
        {
          type: 'task_card',
          block_id: 'roomote-task-task-1-card',
          task_id: 'roomote-task-task-1',
          title: 'Starting task…',
          status: 'in_progress',
          sources: [
            {
              type: 'url',
              url: 'https://roomote.example/task/task-1',
              text: 'Open in Roomote',
            },
          ],
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(
      mocks.postMessageDetailed.mock.calls[0]?.[0]?.blocks[0],
    ).not.toHaveProperty('output');
    expect(mocks.setSlackLiveTaskStreamData).toHaveBeenCalledWith('task-1', {
      teamId: 'T123',
      channel: 'C123',
      messageTs: 'card-ts',
      taskId: 'task-1',
      taskUpdateId: 'roomote-task-task-1',
      threadTs: '100.001',
      title: 'Add a regression test',
      taskUrl: 'https://roomote.example/task/task-1',
    });
    expect(mocks.enqueueTask).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'T123',
      teamDomain: 'acme',
      channelId: 'C123',
      threadTs: '100.001',
      messageId: '100.002',
      liveTaskStream: true,
      rendersTaskLink: true,
      environmentId: 'env-1',
    });
  });

  it('normalizes Slack links but keeps raw mentions before launching the child task', async () => {
    await createLauncher()({
      prompt: 'Ask <@U456> about the regression',
      environmentId: 'env-1',
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.normalizeIncomingText).toHaveBeenCalledWith(
      'Ask <@U456> about the regression',
      { preserveMentions: true },
    );
    expect(mocks.setSlackLiveTaskStreamData).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        title: 'Ask @Readable Name about the regression',
      }),
    );
  });

  it('launches with the original prompt when Slack normalization fails', async () => {
    mocks.normalizeIncomingText.mockRejectedValueOnce(
      new Error('Slack failed'),
    );

    await expect(
      createLauncher()({
        prompt: 'Ask <@U456> about the regression',
        environmentId: 'env-1',
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        postKickoff: vi.fn(),
      }),
    ).resolves.toEqual({
      success: true,
      taskId: 'task-1',
      taskUrl: 'https://roomote.example/task/task-1',
    });
    expect(mocks.setSlackLiveTaskStreamData).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        title: 'Ask <@U456> about the regression',
      }),
    );
  });

  it('links the card to the session when the task already has one', async () => {
    mocks.getSessionForTask.mockResolvedValue({ id: 'session-1' });
    mocks.taskUrl =
      'https://roomote.example/task/task-1?utm_source=slack&utm_medium=link&utm_campaign=fast-delegation';

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    const sessionUrl =
      'https://roomote.example/sessions/session-1?utm_source=slack&utm_medium=link&utm_campaign=fast-delegation&task=task-1';
    expect(mocks.postMessageDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            sources: [
              { type: 'url', url: sessionUrl, text: 'Open in Roomote' },
            ],
          }),
        ],
      }),
    );
    expect(mocks.setSlackLiveTaskStreamData).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ taskUrl: sessionUrl }),
    );
  });

  it('reuses an existing card instead of posting a second one', async () => {
    mocks.getSlackLiveTaskStreamData.mockResolvedValue({
      teamId: 'T123',
      channel: 'C123',
      messageTs: 'existing-ts',
      taskId: 'task-1',
      taskUpdateId: 'roomote-task-task-1',
      threadTs: '100.001',
      title: 'Add a regression test',
    });

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.postMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.setSlackLiveTaskStreamData).not.toHaveBeenCalled();
  });

  it('settles the card when queueing fails after card creation', async () => {
    const queueError = new Error('Redis unavailable');
    mocks.enqueueTask.mockRejectedValue(queueError);

    await expect(
      createLauncher()({
        prompt: 'Add a regression test',
        environmentId: null,
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        postKickoff: vi.fn(),
      }),
    ).rejects.toBe(queueError);

    expect(mocks.settleSlackLiveTaskCardForRun).toHaveBeenCalledWith({
      taskId: 'task-1',
      payload: { liveTaskStream: true },
      status: RunStatus.Canceled,
    });
  });

  it('posts a plain task link when Slack rejects the card', async () => {
    mocks.postMessageDetailed.mockResolvedValue({
      slackErrorCode: 'invalid_blocks',
    });

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.postMessage).toHaveBeenCalledWith(taskLinkFallback);
    expect(mocks.setSlackLiveTaskStreamData).not.toHaveBeenCalled();
  });

  it('posts nothing when the thread root is gone', async () => {
    mocks.postMessageDetailed.mockResolvedValue({
      skippedMissingThreadRoot: true,
    });

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.setSlackLiveTaskStreamData).not.toHaveBeenCalled();
  });

  it('still launches the task and posts the task link when the card path throws', async () => {
    mocks.getSessionForTask.mockResolvedValue({ id: 'session-1' });
    mocks.getSlackLiveTaskStreamData.mockRejectedValue(new Error('redis down'));
    mocks.taskUrl =
      'https://roomote.example/task/task-1?utm_source=slack&utm_medium=link&utm_campaign=fast-delegation';

    await expect(
      createLauncher()({
        prompt: 'Add a regression test',
        environmentId: null,
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        postKickoff: vi.fn(),
      }),
    ).resolves.toMatchObject({ success: true, taskId: 'task-1' });
    expect(mocks.postMessageDetailed).not.toHaveBeenCalled();
    const sessionUrl =
      'https://roomote.example/sessions/session-1?utm_source=slack&utm_medium=link&utm_campaign=fast-delegation&task=task-1';
    expect(mocks.postMessage).toHaveBeenCalledWith({
      ...taskLinkFallback,
      text: `Open in Roomote: ${sessionUrl}`,
      blocks: [
        {
          type: 'markdown',
          text: `[Open in Roomote](${sessionUrl})`,
        },
      ],
    });
    expect(mocks.setSlackLiveTaskStreamData).not.toHaveBeenCalled();
  });

  it('settles an untracked card instead of leaving it spinning when the pointer cannot be stored', async () => {
    mocks.setSlackLiveTaskStreamData.mockRejectedValue(new Error('READONLY'));

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.updateMessage).toHaveBeenCalledWith({
      channel: 'C123',
      ts: 'card-ts',
      message: expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: 'task_card',
            status: 'error',
            sources: [
              {
                type: 'url',
                url: 'https://roomote.example/task/task-1',
                text: 'Open in Roomote',
              },
            ],
          }),
        ],
      }),
    });
    // The card still carries the task link, so no separate link message.
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('falls back to a task link when the untracked card cannot be settled either', async () => {
    mocks.setSlackLiveTaskStreamData.mockRejectedValue(new Error('READONLY'));
    mocks.updateMessage.mockResolvedValue(false);

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.postMessage).toHaveBeenCalledWith(taskLinkFallback);
  });

  describe('code channels', () => {
    const launchInput = {
      prompt: 'Fix the flaky login test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    };

    it('opens a code channel from the triggering message and runs the task there', async () => {
      mocks.openSlackCodeChannel.mockResolvedValue({
        channelId: 'CCODE',
        anchorTs: '200.001',
      });

      await createLauncher(undefined, {
        slackInstallationId: 'install-1',
        requesterSlackUserId: 'U999',
      })(launchInput);

      expect(mocks.openSlackCodeChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          slackInstallationId: 'install-1',
          teamId: 'T123',
          originChannelId: 'C123',
          originMessageTs: '100.002',
          prompt: 'Fix the flaky login test',
          requesterUserId: 'U999',
        }),
      );
      expect(mocks.bindTaskToSlackCodeChannel).toHaveBeenCalledWith({
        channelId: 'CCODE',
        anchorTs: '200.001',
        taskId: 'task-1',
        teamId: 'T123',
      });
      expect(mocks.enqueueTask).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: 'CCODE',
          threadTs: '200.001',
          messageId: '200.001',
        }),
      );
      // The task card goes to the code channel session, not the origin thread.
      expect(mocks.postMessageDetailed).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'CCODE', thread_ts: '200.001' }),
      );
    });

    it('stays in the thread when Slack will not open a code channel', async () => {
      mocks.openSlackCodeChannel.mockResolvedValue(null);

      await createLauncher(undefined, { slackInstallationId: 'install-1' })(
        launchInput,
      );

      expect(mocks.bindTaskToSlackCodeChannel).not.toHaveBeenCalled();
      expect(mocks.enqueueTask).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'C123', threadTs: '100.001' }),
      );
    });

    it('stays in the thread when opening the channel throws', async () => {
      mocks.openSlackCodeChannel.mockRejectedValue(new Error('db down'));

      await createLauncher(undefined, { slackInstallationId: 'install-1' })(
        launchInput,
      );

      expect(mocks.enqueueTask).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'C123', threadTs: '100.001' }),
      );
    });

    it('keeps working in the current code channel and binds the new task to it', async () => {
      mocks.resolveSlackCodeChannelAnchor.mockResolvedValue('100.001');

      await createLauncher(undefined, { slackInstallationId: 'install-1' })(
        launchInput,
      );

      expect(mocks.openSlackCodeChannel).not.toHaveBeenCalled();
      expect(mocks.enqueueTask).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'C123', threadTs: '100.001' }),
      );
      // A later task in the channel follows it like the first one did.
      expect(mocks.bindTaskToSlackCodeChannel).toHaveBeenCalledWith({
        channelId: 'C123',
        anchorTs: '100.001',
        taskId: 'task-1',
        teamId: 'T123',
      });
    });

    it('never opens a code channel when the installation lacks the scope', async () => {
      await createLauncher()(launchInput);

      expect(mocks.resolveSlackCodeChannelAnchor).not.toHaveBeenCalled();
      expect(mocks.openSlackCodeChannel).not.toHaveBeenCalled();
    });
  });
});
