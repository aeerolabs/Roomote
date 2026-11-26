import { z } from 'zod';

/**
 * Per-person access policy keyed on Microsoft Entra app roles
 * (`R_ROLE_ACCESS_POLICY`). A task only receives the deployment secrets, MCP
 * servers and AWS credentials that the person it acts for may use.
 *
 * Anything the policy does not mention keeps reaching every task. Kojo's own
 * admin role grants nothing here: only Entra roles count.
 */

const roleListSchema = z.array(z.string().min(1));

const awsRoleSchema = z.object({
  entraRole: z.string().min(1),
  roleArn: z.string().regex(/^arn:aws[\w-]*:iam::\d{12}:role\/.+$/, {
    message: 'roleArn must be an IAM role ARN',
  }),
});

const roleAccessPolicySchema = z
  .object({
    roleImplies: z.record(z.string().min(1), roleListSchema).default({}),
    envVars: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\*?$|^\*$/, {
          message:
            'envVars keys are env var names, optionally ending in * for a prefix',
        }),
        roleListSchema,
      )
      .default({}),
    mcpServers: z.record(z.string().min(1), roleListSchema).default({}),
    aws: z
      .object({
        region: z.string().min(1),
        // STS AssumeRole accepts 900 seconds up to the role's maximum (12h).
        durationSeconds: z.number().int().min(900).max(43_200).default(3600),
        roles: z.array(awsRoleSchema).min(1),
      })
      .optional(),
  })
  .strict();

export type RoleAccessPolicy = z.infer<typeof roleAccessPolicySchema>;

/** The AWS credential env a task receives when an AWS role is minted. */
const AWS_TASK_CREDENTIAL_ENV_VAR_NAMES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;

let cachedPolicy: { raw: string; policy: RoleAccessPolicy } | null = null;

/**
 * Parse the raw env value. Unset or blank means no policy, which is exactly
 * today's behavior. Throws on invalid JSON or shape, so a typo cannot quietly
 * open access; the env schema runs the same parse at boot.
 */
export function parseRoleAccessPolicy(
  raw: string | undefined | null,
): RoleAccessPolicy | null {
  const trimmed = raw?.trim();

  if (!trimmed) {
    return null;
  }

  if (cachedPolicy?.raw === trimmed) {
    return cachedPolicy.policy;
  }

  let json: unknown;

  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new Error('R_ROLE_ACCESS_POLICY is not valid JSON');
  }

  const parsed = roleAccessPolicySchema.safeParse(json);

  if (!parsed.success) {
    throw new Error(
      `R_ROLE_ACCESS_POLICY is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  cachedPolicy = { raw: trimmed, policy: parsed.data };
  return parsed.data;
}

/** Entra roles the user holds, plus every role they imply, transitively. */
export function expandEntraRoles(
  policy: RoleAccessPolicy,
  roles: readonly string[],
): Set<string> {
  const held = new Set<string>();
  const pending = [...roles];

  while (pending.length > 0) {
    const role = pending.pop()!;

    if (held.has(role)) {
      continue;
    }

    held.add(role);
    pending.push(...(policy.roleImplies[role] ?? []));
  }

  return held;
}

function matchesEnvVarPattern(pattern: string, name: string): boolean {
  return pattern.endsWith('*')
    ? name.startsWith(pattern.slice(0, -1))
    : pattern === name;
}

function holdsAny(held: ReadonlySet<string>, required: readonly string[]) {
  return required.some((role) => held.has(role));
}

/**
 * Whether a deployment env var may reach a task for someone holding `held`.
 * Every policy entry that matches the name must be satisfied, so a narrower
 * entry can only tighten a broader one.
 */
function isEnvVarAllowed(
  policy: RoleAccessPolicy,
  name: string,
  held: ReadonlySet<string>,
): boolean {
  for (const [pattern, required] of Object.entries(policy.envVars)) {
    if (matchesEnvVarPattern(pattern, name) && !holdsAny(held, required)) {
      return false;
    }
  }

  return true;
}

/** Whether the env var is named by any envVars entry. */
function isEnvVarListed(policy: RoleAccessPolicy, name: string) {
  return Object.keys(policy.envVars).some((pattern) =>
    matchesEnvVarPattern(pattern, name),
  );
}

/** Whether an MCP server (curated id or custom server name) is allowed. */
export function isMcpServerAllowed(
  policy: RoleAccessPolicy,
  serverId: string,
  held: ReadonlySet<string>,
): boolean {
  const required = policy.mcpServers[serverId];
  return required === undefined || holdsAny(held, required);
}

/** The first configured AWS role the user holds, in policy order. */
export function selectAwsRole(
  policy: RoleAccessPolicy,
  held: ReadonlySet<string>,
): { entraRole: string; roleArn: string } | null {
  return (
    policy.aws?.roles.find((candidate) => held.has(candidate.entraRole)) ?? null
  );
}

/**
 * Drop env vars the user may not have. When the policy manages AWS, a
 * deployment-level AWS key never reaches a task unless envVars lists it
 * explicitly and the user passes that entry; per-task keys come from STS.
 */
export function filterEnvVarsForRoles(
  policy: RoleAccessPolicy,
  envVars: Record<string, string>,
  held: ReadonlySet<string>,
): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [name, value] of Object.entries(envVars)) {
    if (!isEnvVarAllowed(policy, name, held)) {
      continue;
    }

    if (
      policy.aws &&
      (AWS_TASK_CREDENTIAL_ENV_VAR_NAMES as readonly string[]).includes(name) &&
      !isEnvVarListed(policy, name)
    ) {
      continue;
    }

    filtered[name] = value;
  }

  return filtered;
}

/** Read the Entra roles saved on a user row's metadata. */
export function readEntraRolesFromUserMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return [];
  }

  const roles = (metadata as { entraRoles?: unknown }).entraRoles;

  return Array.isArray(roles)
    ? roles.filter((role): role is string => typeof role === 'string')
    : [];
}

/** STS RoleSessionName allows `[\w+=,.@-]`, 2 to 64 characters. */
export function toAwsRoleSessionName(email: string | null | undefined) {
  const sanitized = (email ?? '').replace(/[^\w+=,.@-]/g, '-').slice(0, 64);
  return sanitized.length >= 2 ? sanitized : 'kojo-task';
}
