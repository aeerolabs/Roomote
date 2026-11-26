import { describe, expect, it } from 'vitest';

import {
  deriveGitHubCoAuthors,
  formatCoAuthorTrailer,
  withCoAuthorTrailers,
} from '../github-co-authors';

const identities = new Map([
  ['asker', { githubLogin: 'asker', githubUserId: 1 }],
  ['helper', { githubLogin: 'helper', githubUserId: 2 }],
  ['asker-alt', { githubLogin: 'asker', githubUserId: 1 }],
  ['bot', { githubLogin: 'dependabot[bot]', githubUserId: 3 }],
  ['app', { githubLogin: 'kojo-the-coder', githubUserId: 4 }],
]);

describe('deriveGitHubCoAuthors', () => {
  it('puts the asker first, then other senders, once each', () => {
    expect(
      deriveGitHubCoAuthors({
        participantUserIds: ['asker', 'helper', 'asker', 'asker-alt', null],
        identities,
      }),
    ).toEqual([
      { githubLogin: 'asker', githubUserId: 1 },
      { githubLogin: 'helper', githubUserId: 2 },
    ]);
  });

  it('skips people without a linked GitHub account', () => {
    expect(
      deriveGitHubCoAuthors({
        participantUserIds: ['unlinked', 'helper'],
        identities,
      }),
    ).toEqual([{ githubLogin: 'helper', githubUserId: 2 }]);
  });

  it('leaves out bots and the app itself', () => {
    expect(
      deriveGitHubCoAuthors({
        participantUserIds: ['bot', 'app', 'asker'],
        identities,
        isExcludedLogin: (login) => login === 'kojo-the-coder',
      }),
    ).toEqual([{ githubLogin: 'asker', githubUserId: 1 }]);
  });
});

describe('withCoAuthorTrailers', () => {
  const trailer = formatCoAuthorTrailer({
    githubLogin: 'helper',
    githubUserId: 2,
  });

  it('formats a GitHub noreply trailer', () => {
    expect(trailer).toBe(
      'Co-authored-by: helper <2+helper@users.noreply.github.com>',
    );
  });

  it('replaces earlier trailers instead of stacking them', () => {
    const once = withCoAuthorTrailers('Fixes the login page.', [trailer]);

    expect(withCoAuthorTrailers(`${once}\n`, [trailer])).toBe(
      `Fixes the login page.\n\n${trailer}`,
    );
  });

  it('keeps other trailers and joins their block', () => {
    const body = 'Fixes it.\n\nCo-Authored-By: Claude <noreply@anthropic.com>';

    expect(withCoAuthorTrailers(body, [trailer])).toBe(`${body}\n${trailer}`);
  });
});
