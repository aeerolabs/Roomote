const { mockEnv, mockUserRows, mockOwnerUserIds, mockStsSend } = vi.hoisted(
  () => ({
    mockEnv: { R_ROLE_ACCESS_POLICY: undefined as string | undefined },
    mockUserRows: new Map<string, { email: string; metadata: unknown }>(),
    mockOwnerUserIds: vi.fn(async (): Promise<string[]> => []),
    mockStsSend: vi.fn(),
  }),
);

vi.mock('@roomote/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/env')>()),
  Env: mockEnv,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (clause: { userId: string }) => ({
          limit: async () => {
            const row = mockUserRows.get(clause.userId);
            return row ? [row] : [];
          },
        }),
      }),
    }),
  },
  users: { id: 'id', deletedAt: 'deletedAt' },
  and: (...clauses: Array<{ userId?: string }>) =>
    clauses.find((clause) => clause.userId) ?? {},
  eq: (_column: unknown, value: string) => ({ userId: value }),
  isNull: () => ({}),
  getTaskHumanOwnerUserIds: mockOwnerUserIds,
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    constructor(readonly config: { region: string }) {}
    send = mockStsSend;
  },
  AssumeRoleCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

import {
  applyRoleAccessToTaskEnv,
  filterMcpServersForUser,
  isMcpServerAllowedForUser,
} from '../role-access';

const POLICY = JSON.stringify({
  roleImplies: { 'Kojo.AWS.Admin': ['Kojo.AWS.ReadOnly'] },
  envVars: { 'LANGFUSE_*': ['Kojo.Langfuse'] },
  mcpServers: { notion: ['Kojo.Notion'] },
  aws: {
    region: 'us-east-1',
    durationSeconds: 1800,
    roles: [
      {
        entraRole: 'Kojo.AWS.Admin',
        roleArn: 'arn:aws:iam::308369304608:role/kojo-aws-admin',
      },
      {
        entraRole: 'Kojo.AWS.ReadOnly',
        roleArn: 'arn:aws:iam::308369304608:role/kojo-aws-readonly',
      },
    ],
  },
});

const DEPLOYMENT_ENV = {
  LANGFUSE_PUBLIC_KEY: 'pk',
  LANGFUSE_SECRET_KEY: 'sk',
  OPENAI_API_KEY: 'open',
  AWS_ACCESS_KEY_ID: 'deployment-key',
  AWS_SECRET_ACCESS_KEY: 'deployment-secret',
  AWS_REGION: 'eu-west-1',
};

function runFor(actingUserId: string | null) {
  return {
    taskRun: { actingUserId, taskId: 'task-1' },
    mintAwsCredentials: true,
  };
}

function addUser(id: string, roles: string[]) {
  mockUserRows.set(id, {
    email: `${id} name@aeero.io`,
    metadata: { entraRoles: roles },
  });
}

describe('role access', () => {
  beforeEach(() => {
    mockEnv.R_ROLE_ACCESS_POLICY = POLICY;
    mockUserRows.clear();
    mockStsSend.mockReset();
    mockOwnerUserIds.mockResolvedValue([]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('task env', () => {
    it('is exactly today without a policy', async () => {
      mockEnv.R_ROLE_ACCESS_POLICY = undefined;

      await expect(
        applyRoleAccessToTaskEnv(DEPLOYMENT_ENV, runFor(null)),
      ).resolves.toBe(DEPLOYMENT_ENV);
      expect(mockStsSend).not.toHaveBeenCalled();
    });

    it('gives Langfuse keys to a Langfuse holder and no one else', async () => {
      addUser('lang', ['Kojo.Langfuse']);
      addUser('plain', []);

      const allowed = await applyRoleAccessToTaskEnv(
        DEPLOYMENT_ENV,
        runFor('lang'),
      );
      const denied = await applyRoleAccessToTaskEnv(
        DEPLOYMENT_ENV,
        runFor('plain'),
      );

      expect(allowed).toMatchObject({ LANGFUSE_SECRET_KEY: 'sk' });
      expect(denied).not.toHaveProperty('LANGFUSE_SECRET_KEY');
      expect(denied.OPENAI_API_KEY).toBe('open');
      // No AWS role: no minted keys, and the deployment's own are stripped.
      expect(denied).not.toHaveProperty('AWS_ACCESS_KEY_ID');
      expect(mockStsSend).not.toHaveBeenCalled();
    });

    it('gives only unrestricted items when no one is acting', async () => {
      const env = await applyRoleAccessToTaskEnv(DEPLOYMENT_ENV, {
        taskRun: null,
        mintAwsCredentials: true,
      });

      expect(env).toEqual({ OPENAI_API_KEY: 'open', AWS_REGION: 'eu-west-1' });
    });

    it("falls back to the task owner's roles when the run has no live actor", async () => {
      addUser('owner', ['Kojo.Langfuse']);
      mockOwnerUserIds.mockResolvedValue(['owner']);

      const env = await applyRoleAccessToTaskEnv(DEPLOYMENT_ENV, runFor(null));

      expect(env.LANGFUSE_PUBLIC_KEY).toBe('pk');
    });

    it('mints the admin AWS role for an admin, overriding deployment keys', async () => {
      addUser('admin', ['Kojo.AWS.Admin']);
      mockStsSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: 'ASIAMINTED',
          SecretAccessKey: 'minted-secret',
          SessionToken: 'minted-token',
        },
      });

      const env = await applyRoleAccessToTaskEnv(
        DEPLOYMENT_ENV,
        runFor('admin'),
      );

      expect(mockStsSend).toHaveBeenCalledTimes(1);
      expect(mockStsSend.mock.calls[0]![0].input).toEqual({
        RoleArn: 'arn:aws:iam::308369304608:role/kojo-aws-admin',
        RoleSessionName: 'admin-name@aeero.io',
        DurationSeconds: 1800,
      });
      expect(env).toMatchObject({
        AWS_ACCESS_KEY_ID: 'ASIAMINTED',
        AWS_SECRET_ACCESS_KEY: 'minted-secret',
        AWS_SESSION_TOKEN: 'minted-token',
        AWS_REGION: 'us-east-1',
        AWS_DEFAULT_REGION: 'us-east-1',
      });
    });

    it('mints the read-only role for a read-only holder', async () => {
      addUser('reader', ['Kojo.AWS.ReadOnly']);
      mockStsSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: 'a',
          SecretAccessKey: 'b',
          SessionToken: 'c',
        },
      });

      await applyRoleAccessToTaskEnv(DEPLOYMENT_ENV, runFor('reader'));

      expect(mockStsSend.mock.calls[0]![0].input.RoleArn).toBe(
        'arn:aws:iam::308369304608:role/kojo-aws-readonly',
      );
    });

    it('runs without AWS keys when STS fails, warning once without secrets', async () => {
      addUser('admin', ['Kojo.AWS.Admin']);
      mockStsSend.mockRejectedValue(
        Object.assign(new Error('not authorized to perform sts:AssumeRole'), {
          name: 'AccessDenied',
        }),
      );

      const env = await applyRoleAccessToTaskEnv(
        DEPLOYMENT_ENV,
        runFor('admin'),
      );

      expect(env).not.toHaveProperty('AWS_ACCESS_KEY_ID');
      expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(env).not.toHaveProperty('AWS_SESSION_TOKEN');
      expect(console.warn).toHaveBeenCalledTimes(1);
      const warning = String(vi.mocked(console.warn).mock.calls[0]![0]);
      expect(warning).toContain('AccessDenied');
      expect(warning).not.toContain('deployment-secret');
    });

    it('does not mint for a snapshot', async () => {
      addUser('admin', ['Kojo.AWS.Admin']);

      await applyRoleAccessToTaskEnv(DEPLOYMENT_ENV, {
        taskRun: { actingUserId: 'admin', taskId: 'task-1' },
        mintAwsCredentials: false,
      });

      expect(mockStsSend).not.toHaveBeenCalled();
    });
  });

  describe('MCP servers', () => {
    const servers = {
      notion: { url: '/api/mcp/notion' },
      linear: { url: '/api/mcp/linear' },
    };

    it('leaves a gated server out of the list for someone without its role', async () => {
      addUser('plain', []);
      addUser('notion-user', ['Kojo.Notion']);

      await expect(
        filterMcpServersForUser(servers, async () => 'plain'),
      ).resolves.toEqual({ linear: servers.linear });
      await expect(
        filterMcpServersForUser(servers, async () => 'notion-user'),
      ).resolves.toEqual(servers);
      await expect(
        filterMcpServersForUser(servers, async () => null),
      ).resolves.toEqual({ linear: servers.linear });
    });

    it('refuses a call to a gated server and looks nothing up for an open one', async () => {
      addUser('plain', []);
      const resolveActor = vi.fn(async () => 'plain');

      await expect(
        isMcpServerAllowedForUser('notion', resolveActor),
      ).resolves.toBe(false);
      await expect(
        isMcpServerAllowedForUser('linear', resolveActor),
      ).resolves.toBe(true);
      expect(resolveActor).toHaveBeenCalledTimes(1);
    });
  });
});
