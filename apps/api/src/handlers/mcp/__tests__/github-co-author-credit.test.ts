import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INTEGRATION_TOOL_FAST_CONVERSATION_HEADER } from '@roomote/types';

const { resolveTrailers, resolveCoAuthors, addAssignees } = vi.hoisted(() => ({
  resolveTrailers: vi.fn(),
  resolveCoAuthors: vi.fn(),
  addAssignees: vi.fn(),
}));
vi.mock('@roomote/sdk/server', async (original) => ({
  ...(await original<typeof import('@roomote/sdk/server')>()),
  resolveConversationGitHubCoAuthorTrailers: resolveTrailers,
  resolveConversationGitHubCoAuthors: resolveCoAuthors,
}));
vi.mock('@roomote/github', async (original) => ({
  ...(await original<typeof import('@roomote/github')>()),
  getOctokit: () => ({ rest: { issues: { addAssignees } } }),
}));
import {
  addGitHubCoAuthorCredit,
  assignConversationToPullRequest,
  readCreatedPullRequestNumber,
} from '../github-co-author-credit';

const conversationId = '11111111-1111-4111-8111-111111111111';
const headers = new Headers({
  [INTEGRATION_TOOL_FAST_CONVERSATION_HEADER]: conversationId,
});
const member = { tokenType: 'auth' as const, userId: 'david' };
const trailer =
  'Co-authored-by: nintang <123+nintang@users.noreply.github.com>';
const call = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});
const argsOf = (request: unknown) =>
  (request as { params: { arguments: Record<string, unknown> } }).params
    .arguments;

beforeEach(() => {
  resolveTrailers.mockReset().mockResolvedValue([trailer]);
});

describe('addGitHubCoAuthorCredit', () => {
  it('credits the conversation on a pull request a member opens', async () => {
    const result = await addGitHubCoAuthorCredit({
      auth: member,
      headers,
      request: call('create_pull_request', { title: 'Fix', body: 'Why.' }),
    });
    expect(argsOf(result).body).toBe(`Why.\n\n${trailer}`);
    expect(resolveTrailers).toHaveBeenCalledWith({
      actingUserId: 'david',
      conversationId,
    });
  });

  it('credits the conversation on a commit a member makes', async () => {
    const result = await addGitHubCoAuthorCredit({
      auth: member,
      headers,
      request: call('create_or_update_file', {
        path: 'a.ts',
        message: 'Fix the label',
      }),
    });
    expect(argsOf(result).message).toBe(`Fix the label\n\n${trailer}`);
  });

  it('leaves reads and coding-task calls alone', async () => {
    const read = call('get_file_contents', { path: 'a.ts' });
    expect(
      await addGitHubCoAuthorCredit({ auth: member, headers, request: read }),
    ).toBe(read);
    const taskWrite = call('create_pull_request', { body: 'Why.' });
    expect(
      await addGitHubCoAuthorCredit({
        auth: { tokenType: 'run', userId: 'david', runId: 1 },
        headers,
        request: taskWrite,
      }),
    ).toBe(taskWrite);
    expect(resolveTrailers).not.toHaveBeenCalled();
  });
});

describe('assigning the conversation to a pull request', () => {
  it('reads the new pull request number from the tool reply', () => {
    const reply = JSON.stringify({
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              url: 'https://github.com/aeerolabs/aeero-v1/pull/1121',
            }),
          },
        ],
      },
    });
    expect(readCreatedPullRequestNumber(reply, 'aeerolabs/aeero-v1')).toBe(
      1121,
    );
    expect(readCreatedPullRequestNumber(reply, 'aeerolabs/other')).toBeNull();
  });

  it('assigns everyone in the conversation with a linked GitHub account', async () => {
    resolveCoAuthors.mockResolvedValue([
      { githubLogin: 'nintang', githubUserId: 123 },
    ]);
    await assignConversationToPullRequest({
      actingUserId: 'david',
      conversationId,
      repositoryFullName: 'aeerolabs/aeero-v1',
      pullNumber: 1121,
      token: 'token',
    });
    expect(addAssignees).toHaveBeenCalledWith({
      owner: 'aeerolabs',
      repo: 'aeero-v1',
      issue_number: 1121,
      assignees: ['nintang'],
    });
  });
});
