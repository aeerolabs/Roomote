import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectCodeChannelBranchDiff } from '../code-channel-diff';

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('collectCodeChannelBranchDiff', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'code-channel-diff-'));
    const remote = join(root, 'remote.git');
    const workspace = join(root, 'workspace');
    git(root, 'init', '--bare', '--initial-branch=main', remote);
    git(root, 'clone', '--quiet', remote, workspace);
    writeFileSync(join(workspace, 'app.txt'), 'one\n');
    git(workspace, 'add', 'app.txt');
    git(workspace, 'commit', '--quiet', '-m', 'initial');
    git(workspace, 'push', '--quiet', 'origin', 'main');
    git(workspace, 'remote', 'set-head', 'origin', 'main');
    git(workspace, 'checkout', '--quiet', '-b', 'agent/fix-login');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns committed and uncommitted work since the default branch', async () => {
    const workspace = join(root, 'workspace');
    writeFileSync(join(workspace, 'app.txt'), 'one\ntwo\n');
    git(workspace, 'commit', '--quiet', '-am', 'committed change');
    writeFileSync(join(workspace, 'app.txt'), 'one\ntwo\nthree\n');

    const result = await collectCodeChannelBranchDiff(workspace);

    expect(result).toMatchObject({
      baseBranch: 'main',
      headBranch: 'agent/fix-login',
    });
    expect(result?.diff).toContain('diff --git a/app.txt b/app.txt');
    expect(result?.diff).toContain('+two');
    expect(result?.diff).toContain('+three');
  });

  it('returns null when the branch has no changes', async () => {
    await expect(
      collectCodeChannelBranchDiff(join(root, 'workspace')),
    ).resolves.toBeNull();
  });
});
