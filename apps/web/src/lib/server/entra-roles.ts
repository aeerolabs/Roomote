import {
  and,
  authAccounts,
  db,
  desc,
  eq,
  sql,
  users,
} from '@roomote/db/server';

import { decodeJwtPayload } from './jwt-payload';

const MICROSOFT_ENTRA_PROVIDER_ID = 'microsoft-entra-id';

/**
 * The Entra app roles in a Microsoft ID token's `roles` claim. Entra omits
 * the claim for a user with no role assignment, which means no roles.
 */
function readEntraRolesFromIdToken(idToken: string): string[] {
  const roles = decodeJwtPayload(idToken)?.roles;

  if (!Array.isArray(roles)) {
    return [];
  }

  return [
    ...new Set(
      roles
        .filter((role): role is string => typeof role === 'string')
        .map((role) => role.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function buildEntraRolesMetadata(roles: string[], now = new Date()) {
  return { entraRoles: roles, entraRolesUpdatedAt: now.toISOString() };
}

/**
 * Save the roles from the latest Microsoft sign-in on the user. Merges into
 * metadata so other keys survive. Matches no row on a first sign-in, before
 * the user row exists; the row is then created with the roles already on it.
 */
export async function saveEntraRolesForUser(userId: string, idToken: string) {
  const patch = buildEntraRolesMetadata(readEntraRolesFromIdToken(idToken));

  await db
    .update(users)
    .set({
      metadata: sql`coalesce(${users.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(eq(users.id, userId));
}

/** Metadata to create a user row with, from their Microsoft account if any. */
export async function getEntraRolesMetadataForNewUser(
  userId: string,
): Promise<Record<string, unknown>> {
  const [account] = await db
    .select({ idToken: authAccounts.idToken })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.userId, userId),
        eq(authAccounts.providerId, MICROSOFT_ENTRA_PROVIDER_ID),
      ),
    )
    .orderBy(desc(authAccounts.updatedAt))
    .limit(1);

  return account?.idToken
    ? buildEntraRolesMetadata(readEntraRolesFromIdToken(account.idToken))
    : {};
}
