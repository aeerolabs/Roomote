// pnpm test src/handlers/slack/__tests__/code-channel-commands.test.ts

import { createHmac } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  findSlackCodeChannel: vi.fn(),
  wrapUpSlackCodeChannel: vi.fn(),
  lookupSlackUserMapping: vi.fn(),
  findInstallation: vi.fn(),
  resolveSlackSigningSecret: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  findSlackCodeChannel: mocks.findSlackCodeChannel,
  wrapUpSlackCodeChannel: mocks.wrapUpSlackCodeChannel,
  SlackNotifier: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  slackInstallations: {},
  resolveSlackSigningSecret: mocks.resolveSlackSigningSecret,
  db: { query: { slackInstallations: { findFirst: mocks.findInstallation } } },
}));

vi.mock('../helpers/user-mapping.js', () => ({
  lookupSlackUserMapping: mocks.lookupSlackUserMapping,
}));

import { handleSlackCodeChannelCommandRequest } from '../code-channel-commands';

const SIGNING_SECRET = 'test-signing-secret';
const NOW_SECONDS = 1_800_000_000;

function signedRequest(fields: Record<string, string>) {
  const rawBody = new URLSearchParams(fields).toString();
  const timestamp = String(NOW_SECONDS);
  const signature = `v0=${createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`, 'utf8')
    .digest('hex')}`;
  return {
    rawBody,
    headers: {
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp,
    },
  };
}

const wrapUpFields = {
  team_id: 'T1',
  channel_id: 'CCODE',
  user_id: 'U1',
  command: '/wrap-up',
  text: '',
};

const openChannel = {
  id: 'row-1',
  teamId: 'T1',
  channelId: 'CCODE',
  slackInstallationId: 'install-1',
  archivedAt: null,
};

describe('handleSlackCodeChannelCommandRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1000 + 1_000);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.resolveSlackSigningSecret.mockResolvedValue(SIGNING_SECRET);
    mocks.findSlackCodeChannel.mockResolvedValue(openChannel);
    mocks.lookupSlackUserMapping.mockResolvedValue({
      activeMapping: { userId: 'user-1' },
    });
    mocks.findInstallation.mockResolvedValue({ botAccessToken: 'xoxb-1' });
    mocks.wrapUpSlackCodeChannel.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a request without a valid Slack signature', async () => {
    const request = signedRequest(wrapUpFields);

    const result = await handleSlackCodeChannelCommandRequest({
      rawBody: request.rawBody,
      headers: { ...request.headers, 'x-slack-signature': 'v0=forged' },
    });

    expect(result.status).toBe(401);
    expect(mocks.findSlackCodeChannel).not.toHaveBeenCalled();
    expect(mocks.wrapUpSlackCodeChannel).not.toHaveBeenCalled();
  });

  it('refuses a Slack user who has not linked a Roomote account', async () => {
    mocks.lookupSlackUserMapping.mockResolvedValue({ activeMapping: null });

    const result = await handleSlackCodeChannelCommandRequest(
      signedRequest(wrapUpFields),
    );

    expect(result).toEqual({
      status: 200,
      body: {
        response_type: 'ephemeral',
        text: 'Link your Slack account to Roomote to use this command.',
      },
    });
    expect(mocks.wrapUpSlackCodeChannel).not.toHaveBeenCalled();
  });

  it('wraps up the channel named in the signed request', async () => {
    const result = await handleSlackCodeChannelCommandRequest(
      signedRequest(wrapUpFields),
    );

    expect(result).toEqual({ status: 200, body: {} });
    expect(mocks.findSlackCodeChannel).toHaveBeenCalledWith({
      teamId: 'T1',
      channelId: 'CCODE',
    });
    expect(mocks.lookupSlackUserMapping).toHaveBeenCalledWith({
      slackUserId: 'U1',
      teamId: 'T1',
    });
    expect(mocks.wrapUpSlackCodeChannel).toHaveBeenCalledWith(
      expect.objectContaining({ channel: openChannel }),
    );
  });

  it('does nothing in a channel that is not an open code channel', async () => {
    mocks.findSlackCodeChannel.mockResolvedValue({
      ...openChannel,
      archivedAt: new Date(),
    });

    const result = await handleSlackCodeChannelCommandRequest(
      signedRequest(wrapUpFields),
    );

    expect(result.body).toMatchObject({ response_type: 'ephemeral' });
    expect(mocks.wrapUpSlackCodeChannel).not.toHaveBeenCalled();
  });

  it('never echoes the bot token in its response', async () => {
    const result = await handleSlackCodeChannelCommandRequest(
      signedRequest({ ...wrapUpFields, command: '/unknown' }),
    );

    expect(JSON.stringify(result)).not.toContain('xoxb-1');
  });
});
