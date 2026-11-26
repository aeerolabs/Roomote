import { Hono } from 'hono';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const { mockFindTaskRun, mockGetTaskHumanOwnerUserIds, mockAllowedUsers } =
  vi.hoisted(() => ({
    mockFindTaskRun: vi.fn(),
    mockGetTaskHumanOwnerUserIds: vi.fn(async (): Promise<string[]> => []),
    // Stands in for "holds a role R_ROLE_ACCESS_POLICY requires for notion".
    mockAllowedUsers: new Set<string>(),
  }));

vi.mock('@roomote/db/server', () => ({
  db: { query: { taskRuns: { findFirst: mockFindTaskRun } } },
  taskRuns: { id: 'id' },
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  getTaskHumanOwnerUserIds: mockGetTaskHumanOwnerUserIds,
}));

vi.mock('@roomote/sdk/server/role-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server/role-access')>()),
  isMcpServerAllowedForUser: async (
    serverId: string,
    resolveActingUserId: () => Promise<string | null>,
  ) => {
    if (serverId !== 'notion') return true;
    const userId = await resolveActingUserId();
    return userId !== null && mockAllowedUsers.has(userId);
  },
}));

import { requireMcpServerAccess } from '../proxy-utils';

function createApp(authContext: AuthTokenContext | RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();
  const upstream = vi.fn(() => new Response('upstream reached'));

  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });
  app.use('/notion', requireMcpServerAccess('notion'));
  app.use('/linear', requireMcpServerAccess('linear'));
  app.post('/notion', upstream);
  app.post('/linear', upstream);

  return { app, upstream };
}

const runToken: RunTokenContext = {
  runId: 7,
  userId: null,
  principal: 'deployment',
  tokenType: 'run',
  version: 1,
};

describe('requireMcpServerAccess', () => {
  beforeEach(() => {
    mockAllowedUsers.clear();
    mockFindTaskRun.mockResolvedValue({ actingUserId: 'u1', taskId: 't1' });
  });

  it('refuses a direct call from a sandbox whose acting person lacks the role', async () => {
    const { app, upstream } = createApp(runToken);

    const response = await app.request('/notion', { method: 'POST' });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        message:
          "You don't have access to notion through Kojo. Ask an admin for the matching role.",
      },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('lets the call through for the acting person holding the role', async () => {
    mockAllowedUsers.add('u1');
    const { app, upstream } = createApp(runToken);

    const response = await app.request('/notion', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("judges by the run's acting person, not the token's own user", async () => {
    mockAllowedUsers.add('token-user');
    const { app } = createApp({ ...runToken, userId: 'token-user' });

    const response = await app.request('/notion', { method: 'POST' });

    expect(response.status).toBe(403);
  });

  it('leaves servers the policy does not list open', async () => {
    const { app } = createApp(runToken);

    const response = await app.request('/linear', { method: 'POST' });

    expect(response.status).toBe(200);
  });

  it("uses a user token's own user for Fast turns", async () => {
    mockAllowedUsers.add('fast-user');
    const { app } = createApp({
      userId: 'fast-user',
      tokenType: 'auth',
      version: 1,
    });

    const response = await app.request('/notion', { method: 'POST' });

    expect(response.status).toBe(200);
  });
});
