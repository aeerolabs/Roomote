// pnpm test src/handlers/slack/events/agent-session-stopped.test.ts

const mocks = vi.hoisted(() => ({
  findActiveSlackTaskRun: vi.fn(),
  resolveSlackCodeChannelAnchor: vi.fn(),
  findRun: vi.fn(),
  lookupSlackUserMapping: vi.fn(),
  stopTaskRun: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  findActiveSlackTaskRun: mocks.findActiveSlackTaskRun,
  resolveSlackCodeChannelAnchor: mocks.resolveSlackCodeChannelAnchor,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  taskRuns: {},
  db: { query: { taskRuns: { findFirst: mocks.findRun } } },
}));

vi.mock('@roomote/sdk/server', () => ({ stopTaskRun: mocks.stopTaskRun }));

vi.mock('../helpers/user-mapping.js', () => ({
  lookupSlackUserMapping: mocks.lookupSlackUserMapping,
}));

import type { SlackWebhookContext } from '../context';
import { handleAgentSessionStoppedEvent } from './agent-session-stopped';

const run = {
  id: 7,
  taskId: 'task-1',
  status: 'running',
  sandboxServerUrl: 'https://sandbox.example',
  actingUserId: 'owner-user',
  payload: {},
  task: { initiatorUserId: 'owner-user' },
};

function createContext() {
  const slack = {
    setAgentSessionStatus: vi.fn().mockResolvedValue({ ok: true }),
    postEphemeralMessage: vi.fn().mockResolvedValue('ts'),
  };
  return {
    slack,
    context: { slack, teamId: 'T1' } as unknown as SlackWebhookContext,
  };
}

describe('handleAgentSessionStoppedEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSlackCodeChannelAnchor.mockResolvedValue('200.001');
    mocks.findActiveSlackTaskRun.mockResolvedValue({ id: 7, taskId: 'task-1' });
    mocks.findRun.mockResolvedValue(run);
    mocks.stopTaskRun.mockResolvedValue({
      success: true,
      mode: 'sandbox_stop',
    });
  });

  it('stops the run for the person who started it, scoped to the code channel session', async () => {
    mocks.lookupSlackUserMapping.mockResolvedValue({
      activeMapping: { userId: 'owner-user' },
    });
    const { slack, context } = createContext();

    await handleAgentSessionStoppedEvent({
      event: {
        type: 'agent_session_stopped',
        channel: 'CCODE',
        user: 'UOWNER',
        event_ts: '1.0',
      },
      context,
    });

    expect(mocks.findActiveSlackTaskRun).toHaveBeenCalledWith('200.001', {
      slackTeamId: 'T1',
    });
    expect(mocks.stopTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        authUserId: 'owner-user',
        terminate: true,
      }),
    );
    expect(slack.setAgentSessionStatus).toHaveBeenCalledWith({
      channel: 'CCODE',
      threadTs: '200.001',
      status: 'active',
    });
  });

  it('refuses someone else in the channel', async () => {
    mocks.lookupSlackUserMapping.mockResolvedValue({
      activeMapping: { userId: 'other-user' },
    });
    const { slack, context } = createContext();

    await handleAgentSessionStoppedEvent({
      event: {
        type: 'agent_session_stopped',
        channel: 'CCODE',
        user: 'UOTHER',
        event_ts: '1.0',
      },
      context,
    });

    expect(mocks.stopTaskRun).not.toHaveBeenCalled();
    expect(slack.postEphemeralMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'CCODE', user: 'UOTHER' }),
    );
  });

  it('refuses a Slack user with no linked account', async () => {
    mocks.lookupSlackUserMapping.mockResolvedValue({ activeMapping: null });
    const { context } = createContext();

    await handleAgentSessionStoppedEvent({
      event: {
        type: 'agent_session_stopped',
        channel: 'C123',
        thread_ts: '100.001',
        user: 'UGUEST',
        event_ts: '1.0',
      },
      context,
    });

    expect(mocks.stopTaskRun).not.toHaveBeenCalled();
  });

  it('only settles the session when no task is running', async () => {
    mocks.findActiveSlackTaskRun.mockResolvedValue(null);
    const { slack, context } = createContext();

    await handleAgentSessionStoppedEvent({
      event: {
        type: 'agent_session_stopped',
        channel: 'C123',
        thread_ts: '100.001',
        user: 'U1',
        event_ts: '1.0',
      },
      context,
    });

    expect(mocks.stopTaskRun).not.toHaveBeenCalled();
    expect(slack.setAgentSessionStatus).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '100.001',
      status: 'active',
    });
  });
});
