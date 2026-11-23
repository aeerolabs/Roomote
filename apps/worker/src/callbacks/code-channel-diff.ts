import { execa } from 'execa';

import { CommandExecutor } from '../sandbox-server/lib/command-executor';

const GIT_TIMEOUT_MS = 30_000;

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execa('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** The remote default branch, e.g. `origin/main`. */
async function resolveBaseRef(cwd: string): Promise<string | null> {
  const remoteHead = (
    await git(cwd, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])
  )?.trim();
  if (remoteHead && remoteHead !== 'origin/HEAD') return remoteHead;

  for (const candidate of ['origin/main', 'origin/master']) {
    if (await git(cwd, ['rev-parse', '--verify', '--quiet', candidate])) {
      return candidate;
    }
  }
  return null;
}

export type CodeChannelBranchDiff = {
  diff: string;
  baseBranch?: string;
  headBranch?: string;
};

/**
 * Everything the task changed relative to where its branch left the default
 * branch: committed work plus uncommitted edits to tracked files, as one
 * unified diff. Read-only (no index changes), so new files the agent has not
 * added yet are not included. With several repositories in the workspace,
 * paths are prefixed with the repository directory.
 */
export async function collectCodeChannelBranchDiff(
  workspacePath: string,
): Promise<CodeChannelBranchDiff | null> {
  const repos = await CommandExecutor.gitFindRepos({
    cwd: workspacePath,
    timeout: GIT_TIMEOUT_MS,
  });
  if (repos.length === 0) return null;

  const parts: string[] = [];
  let baseBranch: string | undefined;
  let headBranch: string | undefined;

  for (const repo of repos) {
    const baseRef = await resolveBaseRef(repo.path);
    const mergeBase = baseRef
      ? (await git(repo.path, ['merge-base', baseRef, 'HEAD']))?.trim()
      : undefined;
    const prefix = repos.length > 1 && repo.name !== '.' ? `${repo.name}/` : '';
    const diff = await git(repo.path, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      `--src-prefix=a/${prefix}`,
      `--dst-prefix=b/${prefix}`,
      mergeBase || 'HEAD',
    ]);
    if (!diff?.trim()) continue;

    parts.push(diff.endsWith('\n') ? diff : `${diff}\n`);
    if (!headBranch) {
      const branch = (
        await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
      )?.trim();
      if (branch && branch !== 'HEAD') headBranch = branch;
      if (baseRef) baseBranch = baseRef.replace(/^origin\//, '');
    }
  }

  if (parts.length === 0) return null;
  return {
    diff: parts.join(''),
    ...(baseBranch ? { baseBranch } : {}),
    ...(headBranch ? { headBranch } : {}),
  };
}
