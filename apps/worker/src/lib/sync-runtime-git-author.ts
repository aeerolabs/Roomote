import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { execa } from 'execa';

import { sdk } from '@roomote/sdk/client';

/**
 * `Co-authored-by` trailers for everyone else working on the task, one per
 * line. The commit instructions end each commit message with this file, so
 * the people who asked for the change are credited however it is merged.
 */
export const COMMIT_CO_AUTHORS_FILE_PATH = join(
  homedir(),
  '.roomote',
  'commit-co-authors',
);

function writeCommitCoAuthors(trailers: readonly string[]): void {
  if (trailers.length === 0) {
    rmSync(COMMIT_CO_AUTHORS_FILE_PATH, { force: true });
    return;
  }
  mkdirSync(dirname(COMMIT_CO_AUTHORS_FILE_PATH), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(COMMIT_CO_AUTHORS_FILE_PATH, `${trailers.join('\n')}\n`, {
    mode: 0o644,
  });
}

/** Refresh only the co-author trailers, leaving the git author alone. */
export async function syncCommitCoAuthors(runId: number): Promise<void> {
  const author = await sdk.taskRuns.getResolvedGitAuthor({ runId });
  writeCommitCoAuthors(author.coAuthorTrailers ?? []);
}

export async function syncRuntimeGitAuthor(options: {
  runId: number;
  workingDirectory: string;
}): Promise<void> {
  const author = await sdk.taskRuns.getResolvedGitAuthor({
    runId: options.runId,
  });

  await execa('git', ['config', '--global', 'user.email', author.email], {
    cwd: options.workingDirectory,
  });
  await execa('git', ['config', '--global', 'user.name', author.name], {
    cwd: options.workingDirectory,
  });
  writeCommitCoAuthors(author.coAuthorTrailers ?? []);
}
