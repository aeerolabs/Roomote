const {
  mockCreateGitHubToken,
  mockFindMapping,
  mockFindTask,
  mockGetPermission,
} = vi.hoisted(() => ({
  mockCreateGitHubToken: vi.fn(),
  mockFindMapping: vi.fn(),
  mockFindTask: vi.fn(),
  mockGetPermission: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(function (this: Record<string, unknown>) {
    this.rest = {
      repos: { getCollaboratorPermissionLevel: mockGetPermission },
    };
  }),
}));

vi.mock('@roomote/auth', () => ({
  createGitHubToken: mockCreateGitHubToken,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      githubUserMappings: { findFirst: mockFindMapping },
      tasks: { findFirst: mockFindTask },
    },
  },
  desc: vi.fn((value: unknown) => ({ type: 'desc', value })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  githubUserMappings: {
    userId: 'githubUserMappings.userId',
    updatedAt: 'githubUserMappings.updatedAt',
  },
  tasks: { id: 'tasks.id' },
}));

import {
  checkGitHubRepositoryWriteAccess,
  clearGitHubWriteAccessCacheForTesting,
} from '../repository-write-access';

const repository = { fullName: 'acme/api', installationId: 'install-acme' };

describe('checkGitHubRepositoryWriteAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGitHubWriteAccessCacheForTesting();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockFindMapping.mockResolvedValue({ githubLogin: 'octo' });
    mockCreateGitHubToken.mockResolvedValue('ghs_installation');
  });

  it.each(['admin', 'maintain', 'write'])(
    'allows a user whose GitHub role is %s',
    async (role) => {
      mockGetPermission.mockResolvedValue({
        data: {
          permission: role === 'maintain' ? 'write' : role,
          role_name: role,
        },
      });

      await expect(
        checkGitHubRepositoryWriteAccess({ userId: 'user-1', repository }),
      ).resolves.toEqual({ allowed: true, githubLogin: 'octo' });
      expect(mockGetPermission).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'api',
        username: 'octo',
      });
      expect(mockCreateGitHubToken).toHaveBeenCalledWith(
        { type: 'installationId', installationId: 'install-acme' },
        undefined,
        { cache: true },
      );
    },
  );

  it('denies a user who can only read or triage', async () => {
    mockGetPermission.mockResolvedValue({
      data: { permission: 'read', role_name: 'triage' },
    });

    const access = await checkGitHubRepositoryWriteAccess({
      userId: 'user-1',
      repository,
    });

    expect(access).toMatchObject({
      allowed: false,
      reason: 'insufficient_permission',
    });
    expect(access.allowed ? '' : access.message).toContain(
      'Ask a maintainer of acme/api for write access.',
    );
  });

  it('denies a user with no linked GitHub account without calling GitHub', async () => {
    mockFindMapping.mockResolvedValue(undefined);

    const access = await checkGitHubRepositoryWriteAccess({
      userId: 'user-1',
      repository,
    });

    expect(access).toMatchObject({ allowed: false, reason: 'not_linked' });
    expect(access.allowed ? '' : access.message).toContain(
      'link your GitHub account',
    );
    expect(mockGetPermission).not.toHaveBeenCalled();
  });

  it('denies a run with no acting user', async () => {
    await expect(
      checkGitHubRepositoryWriteAccess({ userId: null, repository }),
    ).resolves.toMatchObject({ allowed: false, reason: 'no_acting_user' });
    expect(mockFindMapping).not.toHaveBeenCalled();
  });

  it('keeps write access for a built-in automation with no owner', async () => {
    mockFindTask.mockResolvedValue({ initiatorKind: 'automation' });

    await expect(
      checkGitHubRepositoryWriteAccess({
        userId: null,
        taskId: 'task-1',
        repository,
      }),
    ).resolves.toEqual({ allowed: true, githubLogin: null });
    expect(mockGetPermission).not.toHaveBeenCalled();
  });

  it('denies a person-started task whose sender has no account', async () => {
    mockFindTask.mockResolvedValue({ initiatorKind: 'user' });

    await expect(
      checkGitHubRepositoryWriteAccess({
        userId: null,
        taskId: 'task-1',
        repository,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'no_acting_user' });
  });

  it('fails closed on a GitHub error and asks again next time', async () => {
    mockGetPermission
      .mockRejectedValueOnce(
        Object.assign(new Error('Service unavailable'), { status: 503 }),
      )
      .mockResolvedValueOnce({
        data: { permission: 'write', role_name: 'write' },
      });

    await expect(
      checkGitHubRepositoryWriteAccess({ userId: 'user-1', repository }),
    ).resolves.toMatchObject({ allowed: false, reason: 'lookup_failed' });
    await expect(
      checkGitHubRepositoryWriteAccess({ userId: 'user-1', repository }),
    ).resolves.toEqual({ allowed: true, githubLogin: 'octo' });
  });

  it('treats a 404 as no access', async () => {
    mockGetPermission.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

    await expect(
      checkGitHubRepositoryWriteAccess({ userId: 'user-1', repository }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'insufficient_permission',
    });
  });

  it('caches an answer for the same user and repository', async () => {
    mockGetPermission.mockResolvedValue({
      data: { permission: 'write', role_name: 'write' },
    });

    await checkGitHubRepositoryWriteAccess({ userId: 'user-1', repository });
    await checkGitHubRepositoryWriteAccess({ userId: 'user-1', repository });

    expect(mockGetPermission).toHaveBeenCalledTimes(1);
  });
});
