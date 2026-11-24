import { Octokit } from '@octokit/rest';
import pMap from 'p-map';

import { createGitHubToken } from '@roomote/auth';
import { PRODUCT_NAME } from '@roomote/types';
import { db, desc, eq, githubUserMappings } from '@roomote/db/server';

/**
 * Every task pushes and opens pull requests as the GitHub App, which can
 * write to every repository it is installed on. Before a task gets that power
 * for a repository, the person it acts for must be able to write there
 * themselves on GitHub.
 */
export type GitHubWriteAccessDenialReason =
  | 'no_acting_user'
  | 'not_linked'
  | 'insufficient_permission'
  | 'lookup_failed';

export type GitHubWriteAccess =
  | { allowed: true; githubLogin: string }
  | {
      allowed: false;
      reason: GitHubWriteAccessDenialReason;
      message: string;
    };

export type GitHubWriteAccessRepository = {
  fullName: string;
  /** github_installations.id, or GitHub's numeric installation id. */
  installationId: string | number;
};

const WRITE_ACCESS_CACHE_TTL_MS = 5 * 60 * 1000;
const WRITE_ACCESS_CACHE_MAX_ENTRIES = 2000;
const WRITE_ACCESS_LOOKUP_CONCURRENCY = 4;
const WRITE_ROLES = new Set(['admin', 'maintain', 'write']);

const writeAccessCache = new Map<
  string,
  { access: GitHubWriteAccess; expiresAt: number }
>();

export function clearGitHubWriteAccessCacheForTesting(): void {
  writeAccessCache.clear();
}

function denied(
  reason: GitHubWriteAccessDenialReason,
  repositoryFullName: string,
  githubLogin?: string,
): GitHubWriteAccess {
  const cannot = `${PRODUCT_NAME} can read ${repositoryFullName} but will not push or open pull requests there`;
  const message = {
    no_acting_user: `${cannot}: no one with a linked GitHub account asked for this change. Link your GitHub account in ${PRODUCT_NAME}, then ask again.`,
    not_linked: `${cannot} until you link your GitHub account in ${PRODUCT_NAME}.`,
    insufficient_permission: `${cannot}: your GitHub account${githubLogin ? ` ${githubLogin}` : ''} does not have write access to it. Ask a maintainer of ${repositoryFullName} for write access.`,
    lookup_failed: `${cannot} right now: GitHub did not confirm that you have write access to it. Try again in a few minutes.`,
  }[reason];
  return { allowed: false, reason, message };
}

function getErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return null;
  }
  const status = Number(error.status);
  return Number.isFinite(status) ? status : null;
}

async function findLinkedGitHubLogin(userId: string): Promise<string | null> {
  const mapping = await db.query.githubUserMappings.findFirst({
    where: eq(githubUserMappings.userId, userId),
    orderBy: [desc(githubUserMappings.updatedAt)],
    columns: { githubLogin: true },
  });
  return mapping?.githubLogin?.trim() || null;
}

async function lookUpWriteAccess(
  repository: GitHubWriteAccessRepository,
  githubLogin: string,
): Promise<GitHubWriteAccess> {
  const [owner, repo] = repository.fullName.split('/');
  if (!owner || !repo) {
    return denied('lookup_failed', repository.fullName);
  }

  const cacheKey = [
    String(repository.installationId),
    repository.fullName.toLowerCase(),
    githubLogin.toLowerCase(),
  ].join('\0');
  const cached = writeAccessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.access;
  }
  writeAccessCache.delete(cacheKey);

  let access: GitHubWriteAccess;
  try {
    const token = await createGitHubToken(
      {
        type: 'installationId',
        installationId: repository.installationId,
      },
      undefined,
      { cache: true },
    );
    const octokit = new Octokit({
      auth: token,
      userAgent: 'Roomote',
      request: { headers: { 'X-GitHub-Api-Version': '2022-11-28' } },
    });
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: githubLogin,
    });
    // `role_name` distinguishes maintain from triage; `permission` folds them
    // into write and read.
    const role = data.role_name || data.permission;
    access = WRITE_ROLES.has(role)
      ? { allowed: true, githubLogin }
      : denied('insufficient_permission', repository.fullName, githubLogin);
  } catch (error) {
    // 404: the login is not a GitHub user, or cannot see the repository.
    if (getErrorStatus(error) === 404) {
      access = denied(
        'insufficient_permission',
        repository.fullName,
        githubLogin,
      );
    } else {
      // Fail closed, and do not cache, so the next attempt asks again.
      console.warn(
        JSON.stringify({
          event: 'github_write_access_lookup_failed',
          repository: repository.fullName,
          status: getErrorStatus(error),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return denied('lookup_failed', repository.fullName);
    }
  }

  writeAccessCache.set(cacheKey, {
    access,
    expiresAt: Date.now() + WRITE_ACCESS_CACHE_TTL_MS,
  });
  while (writeAccessCache.size > WRITE_ACCESS_CACHE_MAX_ENTRIES) {
    const oldest = writeAccessCache.keys().next().value;
    if (oldest === undefined) break;
    writeAccessCache.delete(oldest);
  }
  return access;
}

/**
 * Whether the person a task acts for may push to and open pull requests in
 * each repository, keyed by repository full name. Looks up their linked
 * GitHub login once, then asks GitHub for their permission per repository.
 */
export async function checkGitHubWriteAccess({
  userId,
  repositories,
}: {
  userId: string | null | undefined;
  repositories: GitHubWriteAccessRepository[];
}): Promise<Map<string, GitHubWriteAccess>> {
  const unique = [
    ...new Map(repositories.map((row) => [row.fullName, row])).values(),
  ];
  const result = new Map<string, GitHubWriteAccess>();
  if (unique.length === 0) {
    return result;
  }

  const githubLogin = userId ? await findLinkedGitHubLogin(userId) : null;
  if (!githubLogin) {
    for (const repository of unique) {
      result.set(
        repository.fullName,
        denied(userId ? 'not_linked' : 'no_acting_user', repository.fullName),
      );
    }
    return result;
  }

  await pMap(
    unique,
    async (repository) => {
      result.set(
        repository.fullName,
        await lookUpWriteAccess(repository, githubLogin),
      );
    },
    { concurrency: WRITE_ACCESS_LOOKUP_CONCURRENCY },
  );
  return result;
}

export async function checkGitHubRepositoryWriteAccess({
  userId,
  repository,
}: {
  userId: string | null | undefined;
  repository: GitHubWriteAccessRepository;
}): Promise<GitHubWriteAccess> {
  const result = await checkGitHubWriteAccess({
    userId,
    repositories: [repository],
  });
  return result.get(repository.fullName)!;
}
