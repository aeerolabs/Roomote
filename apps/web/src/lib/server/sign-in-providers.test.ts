import { describe, expect, it } from 'vitest';

import {
  getAllowedSignInMethods,
  isAuthRequestAllowedBySignInPolicy,
} from './sign-in-providers';

describe('getAllowedSignInMethods', () => {
  it('allows every method when unset', () => {
    expect(getAllowedSignInMethods(undefined)).toBeNull();
    expect(getAllowedSignInMethods('  ')).toBeNull();
  });

  it('reads a comma-separated list and ignores unknown names', () => {
    expect([...(getAllowedSignInMethods(' Microsoft, nope ') ?? [])]).toEqual([
      'microsoft',
    ]);
  });
});

describe('isAuthRequestAllowedBySignInPolicy', () => {
  const microsoftOnly = getAllowedSignInMethods('microsoft');

  it('lets Microsoft sign-in through', () => {
    expect(
      isAuthRequestAllowedBySignInPolicy(
        '/sign-in/social',
        { provider: 'microsoft-entra-id' },
        microsoftOnly,
      ),
    ).toBe(true);
  });

  it('blocks Slack, email and other providers when only Microsoft is allowed', () => {
    expect(
      isAuthRequestAllowedBySignInPolicy(
        '/sign-in/social',
        { provider: 'slack' },
        microsoftOnly,
      ),
    ).toBe(false);
    expect(
      isAuthRequestAllowedBySignInPolicy(
        '/sign-in/oauth2',
        { providerId: 'gitlab' },
        microsoftOnly,
      ),
    ).toBe(false);
    expect(
      isAuthRequestAllowedBySignInPolicy(
        '/sign-in/email',
        { email: 'person@example.com' },
        microsoftOnly,
      ),
    ).toBe(false);
    expect(
      isAuthRequestAllowedBySignInPolicy('/sign-up/email', {}, microsoftOnly),
    ).toBe(false);
  });

  it('never blocks linking a provider to someone already signed in', () => {
    expect(
      isAuthRequestAllowedBySignInPolicy(
        '/oauth2/link',
        { providerId: 'slack' },
        microsoftOnly,
      ),
    ).toBe(true);
    expect(
      isAuthRequestAllowedBySignInPolicy(
        '/link-social',
        { provider: 'slack' },
        microsoftOnly,
      ),
    ).toBe(true);
  });

  it('changes nothing without a policy', () => {
    expect(
      isAuthRequestAllowedBySignInPolicy(
        '/sign-in/social',
        { provider: 'slack' },
        null,
      ),
    ).toBe(true);
  });
});
