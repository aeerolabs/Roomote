import { getOctokit } from '@roomote/github';
import {
  resolveConversationGitHubCoAuthors,
  resolveConversationGitHubCoAuthorTrailers,
  withCoAuthorTrailers,
} from '@roomote/sdk/server';

import { getToolCallName, type McpAuthContext } from './proxy-utils';
import { readFastConversationIdHeader } from './tool-approval-enforcement';

/**
 * The argument each GitHub write tool turns into a commit message or a pull
 * request description, where co-author trailers belong.
 */
const CREDITED_ARGUMENT_BY_TOOL: Record<string, 'body' | 'message'> = {
  create_pull_request: 'body',
  create_or_update_file: 'message',
  push_files: 'message',
  delete_file: 'message',
};

/**
 * A member's GitHub writes from a conversation commit and open pull requests
 * as the GitHub App, so the people in that conversation would otherwise get no
 * credit. Ends the commit message or pull request description with a
 * Co-authored-by trailer for each of them who has a linked GitHub account,
 * the same credit a coding task's commits and pull requests carry.
 */
export async function addGitHubCoAuthorCredit(input: {
  auth: McpAuthContext;
  request: unknown;
  headers: Headers;
}): Promise<unknown> {
  const name = getToolCallName(input.request);
  const field = name ? CREDITED_ARGUMENT_BY_TOOL[name] : undefined;
  if (!field || input.auth.tokenType !== 'auth') {
    return input.request;
  }
  const request = input.request as {
    params: { arguments?: Record<string, unknown> };
  };
  const args = request.params.arguments ?? {};
  const current = args[field];
  if (current !== undefined && typeof current !== 'string') {
    return input.request;
  }

  const trailers = await resolveConversationGitHubCoAuthorTrailers({
    actingUserId: input.auth.userId,
    conversationId: readFastConversationIdHeader(input.headers),
  });
  if (trailers.length === 0) {
    return input.request;
  }

  return {
    ...request,
    params: {
      ...request.params,
      arguments: {
        ...args,
        [field]: withCoAuthorTrailers(current ?? '', trailers),
      },
    },
  };
}

/**
 * The number of the pull request a `create_pull_request` reply describes, or
 * null. The reply nests GitHub's JSON inside a JSON-RPC text block (sometimes
 * as a server-sent event), so the pull request's own URL is the steady anchor.
 */
export function readCreatedPullRequestNumber(
  replyText: string,
  repositoryFullName: string,
): number | null {
  const escaped = repositoryFullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`github\\.com/${escaped}/pull/(\\d+)`, 'i').exec(
    replyText,
  );
  return match ? Number(match[1]) : null;
}

/**
 * GitHub lists a pull request's participants from its author, commenters and
 * assignees. A pull request Kojo opens is authored by the GitHub App, so the
 * people who asked for it are assigned instead, which also shows them in the
 * pull request's participants. Best effort: a failure is logged, never raised.
 */
export async function assignConversationToPullRequest({
  actingUserId,
  conversationId,
  repositoryFullName,
  pullNumber,
  token,
}: {
  actingUserId: string;
  conversationId: string | null;
  repositoryFullName: string;
  pullNumber: number;
  token: string;
}): Promise<void> {
  try {
    const assignees = (
      await resolveConversationGitHubCoAuthors({ actingUserId, conversationId })
    ).map((identity) => identity.githubLogin);
    if (assignees.length === 0) {
      return;
    }
    const [owner, repo] = repositoryFullName.split('/');
    await getOctokit(token).rest.issues.addAssignees({
      owner: owner!,
      repo: repo!,
      issue_number: pullNumber,
      assignees,
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'github_mcp_pr_assign_failed',
        repositoryFullName,
        pullNumber,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
