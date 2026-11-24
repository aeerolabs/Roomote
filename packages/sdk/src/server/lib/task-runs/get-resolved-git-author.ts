import { resolveSourceControlProviderFromPayload } from '@roomote/types';
import { db, taskRuns, eq } from '@roomote/db/server';

import { resolveTaskGitHubCoAuthorTrailers } from '../pull-requests/github-co-authors';
import { resolveGitAuthor } from './dequeue-helpers';

const GITHUB_NOREPLY_ID = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i;

export async function getResolvedGitAuthor(runId: number) {
  const { taskRun, author } = await db.transaction(async (tx) => {
    const taskRun = await tx.query.taskRuns.findFirst({
      where: eq(taskRuns.id, runId),
    });

    if (!taskRun) {
      throw new Error(`Task run not found: ${runId}`);
    }

    return { taskRun, author: await resolveGitAuthor(tx, taskRun) };
  });

  // Everyone else who worked on the task is credited on each commit; the
  // commit's own author needs no trailer.
  const authorGitHubUserId = GITHUB_NOREPLY_ID.exec(author.email)?.[1];
  const coAuthorTrailers =
    resolveSourceControlProviderFromPayload(taskRun.payload) === 'github'
      ? await resolveTaskGitHubCoAuthorTrailers(taskRun, {
          excludeGitHubUserId: authorGitHubUserId
            ? Number(authorGitHubUserId)
            : null,
        })
      : [];

  return { ...author, coAuthorTrailers };
}
