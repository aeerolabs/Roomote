import { Env } from './env';

type SignInMethod = 'microsoft' | 'slack' | 'email';

const SIGN_IN_METHODS: ReadonlySet<string> = new Set([
  'microsoft',
  'slack',
  'email',
]);

/**
 * The sign-in methods this deployment allows, from R_SIGN_IN_PROVIDERS
 * (comma-separated), or null when every configured method is allowed.
 */
export function getAllowedSignInMethods(
  raw: string | undefined = Env.R_SIGN_IN_PROVIDERS,
): ReadonlySet<SignInMethod> | null {
  if (!raw?.trim()) {
    return null;
  }

  const allowed = new Set<SignInMethod>();
  for (const part of raw.split(',')) {
    const method = part.trim().toLowerCase();
    if (SIGN_IN_METHODS.has(method)) {
      allowed.add(method as SignInMethod);
    }
  }
  return allowed;
}

/**
 * The sign-in an auth API request starts, or null when it starts none.
 * Linking a provider to someone already signed in is not a sign-in.
 * Providers other than Microsoft and Slack are returned by their own id, so
 * an allow-list only lets through what it names.
 */
function getSignInMethodForAuthRequest(
  path: string,
  body: unknown,
): string | null {
  if (path === '/sign-in/email' || path === '/sign-up/email') {
    return 'email';
  }

  if (path !== '/sign-in/social' && path !== '/sign-in/oauth2') {
    return null;
  }

  const { provider, providerId } = (body ?? {}) as {
    provider?: unknown;
    providerId?: unknown;
  };
  const id = typeof provider === 'string' ? provider : providerId;
  if (typeof id !== 'string' || !id) {
    return null;
  }
  return id === 'microsoft-entra-id' ? 'microsoft' : id;
}

/** Whether an auth API request may proceed under the sign-in allow-list. */
export function isAuthRequestAllowedBySignInPolicy(
  path: string,
  body: unknown,
  allowed: ReadonlySet<SignInMethod> | null = getAllowedSignInMethods(),
): boolean {
  if (!allowed) {
    return true;
  }
  const method = getSignInMethodForAuthRequest(path, body);
  return method === null || allowed.has(method as SignInMethod);
}
