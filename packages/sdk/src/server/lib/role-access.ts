import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import {
  Env,
  expandEntraRoles,
  filterEnvVarsForRoles,
  isMcpServerAllowed,
  parseRoleAccessPolicy,
  readEntraRolesFromUserMetadata,
  selectAwsRole,
  toAwsRoleSessionName,
  type RoleAccessPolicy,
} from '@roomote/env';
import {
  and,
  db,
  eq,
  getTaskHumanOwnerUserIds,
  isNull,
  users,
} from '@roomote/db/server';

const STS_TIMEOUT_MS = 10_000;

function getRoleAccessPolicy(): RoleAccessPolicy | null {
  const raw = Env.R_ROLE_ACCESS_POLICY;
  return raw?.trim() ? parseRoleAccessPolicy(raw) : null;
}

type ActingUserAccess = {
  userId: string | null;
  email: string | null;
  roles: ReadonlySet<string>;
};

/**
 * The person a task acts for and the Entra roles they hold (with implied
 * roles). No person, or a removed one, holds no roles.
 */
async function loadActingUserAccess(
  policy: RoleAccessPolicy,
  userId: string | null | undefined,
): Promise<ActingUserAccess> {
  if (!userId) {
    return { userId: null, email: null, roles: new Set() };
  }

  const [user] = await db
    .select({ email: users.email, metadata: users.metadata })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  return {
    userId,
    email: user?.email || null,
    roles: user
      ? expandEntraRoles(policy, readEntraRolesFromUserMetadata(user.metadata))
      : new Set(),
  };
}

/**
 * Who a task run acts for: the live actor, else the human owner of its task.
 * The same rule the MCP proxy uses to pick whose connections a call runs as.
 */
async function resolveTaskRunAccessUserId(taskRun: {
  actingUserId: string | null;
  taskId: string;
}): Promise<string | null> {
  if (taskRun.actingUserId) {
    return taskRun.actingUserId;
  }

  const [ownerUserId] = await getTaskHumanOwnerUserIds(db, taskRun.taskId);
  return ownerUserId ?? null;
}

function describeError(error: unknown): string {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/**
 * Short-lived AWS credentials for one task, from STS AssumeRole with the
 * server's own identity (the default credential chain). Returns null on any
 * failure, after one warning that never includes credentials.
 */
async function mintAwsTaskCredentials(input: {
  region: string;
  roleArn: string;
  durationSeconds: number;
  sessionName: string;
}): Promise<Record<string, string> | null> {
  try {
    const client = new STSClient({ region: input.region });
    const response = await client.send(
      new AssumeRoleCommand({
        RoleArn: input.roleArn,
        RoleSessionName: input.sessionName,
        DurationSeconds: input.durationSeconds,
      }),
      { abortSignal: AbortSignal.timeout(STS_TIMEOUT_MS) },
    );
    const credentials = response.Credentials;

    if (
      !credentials?.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !credentials.SessionToken
    ) {
      throw new Error('AssumeRole returned no credentials');
    }

    return {
      AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: credentials.SessionToken,
      AWS_REGION: input.region,
      AWS_DEFAULT_REGION: input.region,
    };
  } catch (error) {
    console.warn(
      `[role-access] Could not assume ${input.roleArn} for a task; it runs without AWS credentials. ${describeError(error)}`,
    );
    return null;
  }
}

/**
 * Apply R_ROLE_ACCESS_POLICY to the env a sandbox receives: drop secrets the
 * acting person may not have, then add per-task AWS credentials for their
 * AWS role. Minted credentials win over any deployment-level AWS values.
 * Without a policy the env is returned unchanged.
 */
export type TaskEnvRoleAccess = {
  /** The run the env is for; null gives only what every task may have. */
  taskRun: { actingUserId: string | null; taskId: string } | null;
  mintAwsCredentials: boolean;
};

export async function applyRoleAccessToTaskEnv(
  envVars: Record<string, string>,
  options: TaskEnvRoleAccess,
): Promise<Record<string, string>> {
  const policy = getRoleAccessPolicy();

  if (!policy) {
    return envVars;
  }

  const access = await loadActingUserAccess(
    policy,
    options.taskRun ? await resolveTaskRunAccessUserId(options.taskRun) : null,
  );
  const filtered = filterEnvVarsForRoles(policy, envVars, access.roles);

  if (!policy.aws || !options.mintAwsCredentials) {
    return filtered;
  }

  const awsRole = selectAwsRole(policy, access.roles);

  if (!awsRole) {
    return filtered;
  }

  const credentials = await mintAwsTaskCredentials({
    region: policy.aws.region,
    roleArn: awsRole.roleArn,
    durationSeconds: policy.aws.durationSeconds,
    sessionName: toAwsRoleSessionName(access.email ?? access.userId),
  });

  return credentials ? { ...filtered, ...credentials } : filtered;
}

export function formatMcpServerAccessDenied(serverId: string): string {
  return `You don't have access to ${serverId} through Kojo. Ask an admin for the matching role.`;
}

/**
 * Whether the acting person may use an MCP server. Looks nothing up when the
 * policy leaves the server open.
 */
export async function isMcpServerAllowedForUser(
  serverId: string,
  resolveActingUserId: () => Promise<string | null>,
): Promise<boolean> {
  const policy = getRoleAccessPolicy();

  if (!policy || policy.mcpServers[serverId] === undefined) {
    return true;
  }

  const access = await loadActingUserAccess(
    policy,
    await resolveActingUserId(),
  );
  return isMcpServerAllowed(policy, serverId, access.roles);
}

/** Drop the MCP servers the acting person may not use from a resolved map. */
export async function filterMcpServersForUser<T>(
  servers: Record<string, T>,
  resolveActingUserId: () => Promise<string | null>,
): Promise<Record<string, T>> {
  const policy = getRoleAccessPolicy();

  if (
    !policy ||
    !Object.keys(servers).some((name) => policy.mcpServers[name] !== undefined)
  ) {
    return servers;
  }

  const access = await loadActingUserAccess(
    policy,
    await resolveActingUserId(),
  );

  return Object.fromEntries(
    Object.entries(servers).filter(([name]) =>
      isMcpServerAllowed(policy, name, access.roles),
    ),
  );
}
