import {
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
