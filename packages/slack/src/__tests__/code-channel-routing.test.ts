// pnpm --filter @roomote/slack test src/__tests__/code-channel-routing.test.ts

import {
  rememberSlackCodeChannelAnchor,
  resolveSlackCodeChannelAnchor,
  setSlackCodeChannelAnchorResolver,
} from '../code-channel-routing';
import { SlackNotifier } from '../slack-notifier';

const { apiCallMock, startStreamMock, WebClientMock } = vi.hoisted(() => ({
  apiCallMock: vi.fn(),
  startStreamMock: vi.fn(),
  WebClientMock: vi.fn().mockImplementation(function () {
    return { apiCall: apiCallMock, chat: { startStream: startStreamMock } };
  }),
}));

vi.mock('@slack/web-api', () => ({ WebClient: WebClientMock }));

const CODE_CHANNEL = 'CCODE';
const ANCHOR_TS = '200.001';

type FetchMock = ReturnType<typeof vi.fn>;
const setFetch = (fetchMock: FetchMock) => {
  (globalThis as unknown as { fetch: FetchMock }).fetch = fetchMock;
};

const okJson = (body: unknown) => ({ ok: true, json: async () => body });

describe('Slack code channel edge translation', () => {
  const originalBaseUrl = process.env.SLACK_API_BASE_URL;
  let notifier: SlackNotifier;

  beforeEach(() => {
    process.env.SLACK_API_BASE_URL = 'https://slack.com/api/';
    vi.clearAllMocks();
    setSlackCodeChannelAnchorResolver(async (channelId) =>
      channelId === CODE_CHANNEL ? ANCHOR_TS : null,
    );
    notifier = new SlackNotifier('xoxb-test-token');
  });

  afterEach(() => {
    setSlackCodeChannelAnchorResolver(null);
    if (originalBaseUrl === undefined) delete process.env.SLACK_API_BASE_URL;
    else process.env.SLACK_API_BASE_URL = originalBaseUrl;
  });

  it('posts replies to the anchor thread at the top level of the code channel', async () => {
    const fetchMock = vi
      .fn()
      // Thread-root existence check, answered from conversations.history.
      .mockResolvedValueOnce(
        okJson({ ok: true, messages: [{ ts: ANCHOR_TS, text: 'kickoff' }] }),
      )
      .mockResolvedValueOnce(okJson({ ok: true, ts: '200.005' }));
    setFetch(fetchMock);

    await expect(
      notifier.postMessage({
        channel: CODE_CHANNEL,
        thread_ts: ANCHOR_TS,
        text: 'Working on it',
      }),
    ).resolves.toBe('200.005');

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'conversations.history?channel=CCODE&oldest=200.001',
    );
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(String(init.body))).toEqual({
      channel: CODE_CHANNEL,
      text: 'Working on it',
    });
  });

  it('leaves threads in ordinary channels untouched', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({ ok: true, messages: [{ ts: '100.001', text: 'root' }] }),
      )
      .mockResolvedValueOnce(okJson({ ok: true, ts: '100.002' }));
    setFetch(fetchMock);

    await notifier.postMessage({
      channel: 'C123',
      thread_ts: '100.001',
      text: 'reply',
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'conversations.replies?channel=C123&ts=100.001',
    );
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      thread_ts: '100.001',
    });
  });

  it('keeps a reply the user threaded under another message in that thread', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({ ok: true, messages: [{ ts: '200.009', text: 'question' }] }),
      )
      .mockResolvedValueOnce(okJson({ ok: true, ts: '200.010' }));
    setFetch(fetchMock);

    await notifier.postMessage({
      channel: CODE_CHANNEL,
      thread_ts: '200.009',
      text: 'answer',
    });

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      thread_ts: '200.009',
    });
  });

  it('reads the session "thread" as the channel history from the anchor, oldest first', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      okJson({
        ok: true,
        has_more: false,
        messages: [
          { ts: '200.003', user: 'U1', text: 'second' },
          { ts: '200.002', user: 'U1', text: 'first' },
          { ts: ANCHOR_TS, bot_id: 'B1', text: 'kickoff' },
        ],
      }),
    );
    setFetch(fetchMock);
    vi.spyOn(
      notifier as unknown as { getUsersInfo: () => Promise<unknown> },
      'getUsersInfo',
    ).mockResolvedValue(new Map());

    const messages = await notifier.fetchThreadMessages({
      channel: CODE_CHANNEL,
      threadTs: ANCHOR_TS,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'conversations.history?channel=CCODE&oldest=200.001&inclusive=true',
    );
    expect(messages.map((message) => message.text)).toEqual([
      'kickoff',
      'first',
      'second',
    ]);
  });

  it('sets the code channel session status without a thread', async () => {
    apiCallMock.mockResolvedValue({ ok: true });

    await notifier.setAgentSessionStatus({
      channel: CODE_CHANNEL,
      threadTs: ANCHOR_TS,
      status: 'processing',
      title: 'ignored for channels',
    });

    expect(apiCallMock).toHaveBeenCalledWith('agents.sessions.setStatus', {
      channel_id: CODE_CHANNEL,
      status: 'processing',
    });
  });

  it('starts a top-level stream in the code channel', async () => {
    startStreamMock.mockResolvedValue({ ok: true, ts: '200.020' });

    await notifier.startMessageStream({
      channel: CODE_CHANNEL,
      threadTs: ANCHOR_TS,
      recipientTeamId: 'T1',
      recipientUserId: 'U1',
      markdownText: 'Thinking',
    });

    expect(startStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CODE_CHANNEL, thread_ts: '0' }),
    );
  });

  it('translates nothing when no resolver is registered', async () => {
    setSlackCodeChannelAnchorResolver(null);
    await expect(resolveSlackCodeChannelAnchor(CODE_CHANNEL)).resolves.toBe(
      null,
    );

    rememberSlackCodeChannelAnchor(CODE_CHANNEL, ANCHOR_TS);
    await expect(resolveSlackCodeChannelAnchor(CODE_CHANNEL)).resolves.toBe(
      ANCHOR_TS,
    );
  });

  it('treats a failing lookup as an ordinary channel', async () => {
    setSlackCodeChannelAnchorResolver(async () => {
      throw new Error('db down');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(resolveSlackCodeChannelAnchor('COTHER')).resolves.toBe(null);
  });
});
