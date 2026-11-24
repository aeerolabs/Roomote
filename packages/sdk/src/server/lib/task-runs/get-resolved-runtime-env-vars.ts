import {
  resolveSourceControlProviderFromPayload,
  type AuthTokenContext,
  type RunTokenContext,
} from '@roomote/types';
import { db, eq, taskRuns } from '@roomote/db/server';

import { fetchResolvedRuntimeEnvVars } from './dequeue-helpers';

export async function getResolvedRuntimeEnvVars(
  _auth: AuthTokenContext | RunTokenContext,
  input: { runId: number },
) {
  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.runId),
    columns: { id: true, payload: true, actingUserId: true, taskId: true },
  });

  if (!taskRun) {
    throw new Error('Task run not found');
  }

  // A live reload replaces the sandbox env, so it re-mints AWS credentials
  // for the acting person rather than dropping them.
  return fetchResolvedRuntimeEnvVars(undefined, {
    sourceControlProvider: resolveSourceControlProviderFromPayload(
      taskRun.payload,
    ),
    roleAccess: { taskRun, mintAwsCredentials: true },
  });
}
