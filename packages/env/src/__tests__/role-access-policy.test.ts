import {
  createRoomoteEnv,
  expandEntraRoles,
  filterEnvVarsForRoles,
  isMcpServerAllowed,
  parseRoleAccessPolicy,
  selectAwsRole,
  toAwsRoleSessionName,
} from '../index';

const POLICY = {
  roleImplies: { 'Kojo.AWS.Admin': ['Kojo.AWS.ReadOnly'] },
  envVars: { 'LANGFUSE_*': ['Kojo.Langfuse'] },
  mcpServers: { notion: ['Kojo.Notion'] },
  aws: {
    region: 'us-east-1',
    durationSeconds: 3600,
    roles: [
      {
        entraRole: 'Kojo.AWS.Admin',
        roleArn: 'arn:aws:iam::308369304608:role/kojo-aws-admin',
      },
      {
        entraRole: 'Kojo.AWS.ReadOnly',
        roleArn: 'arn:aws:iam::308369304608:role/kojo-aws-readonly',
      },
    ],
  },
};

const policy = parseRoleAccessPolicy(JSON.stringify(POLICY))!;

const DEPLOYMENT_ENV = {
  LANGFUSE_PUBLIC_KEY: 'pk',
  LANGFUSE_SECRET_KEY: 'sk',
  OPENAI_API_KEY: 'open',
  AWS_ACCESS_KEY_ID: 'deployment-key',
  AWS_SECRET_ACCESS_KEY: 'deployment-secret',
};

describe('R_ROLE_ACCESS_POLICY', () => {
  it('means no policy when unset or blank, and rejects a malformed one', () => {
    expect(parseRoleAccessPolicy(undefined)).toBeNull();
    expect(parseRoleAccessPolicy('  ')).toBeNull();
    expect(() => parseRoleAccessPolicy('{not json')).toThrow(/not valid JSON/);
    expect(() =>
      parseRoleAccessPolicy(
        JSON.stringify({ aws: { region: 'us-east-1', roles: [] } }),
      ),
    ).toThrow(/invalid/);
  });

  it('fails env validation on an invalid policy so a typo cannot open access', () => {
    expect(() =>
      createRoomoteEnv({
        NODE_ENV: 'test',
        R_ROLE_ACCESS_POLICY: '{"envVars": {"LANGFUSE_*": "Kojo.Langfuse"}}',
      }),
    ).toThrow();
    expect(
      createRoomoteEnv({
        NODE_ENV: 'test',
        R_ROLE_ACCESS_POLICY: JSON.stringify(POLICY),
      }).R_ROLE_ACCESS_POLICY,
    ).toBe(JSON.stringify(POLICY));
  });

  it('gives a listed secret only to a holder of its role', () => {
    const holder = filterEnvVarsForRoles(
      policy,
      DEPLOYMENT_ENV,
      expandEntraRoles(policy, ['Kojo.Langfuse']),
    );
    const other = filterEnvVarsForRoles(
      policy,
      DEPLOYMENT_ENV,
      expandEntraRoles(policy, ['Kojo.AWS.ReadOnly']),
    );
    const nobody = filterEnvVarsForRoles(policy, DEPLOYMENT_ENV, new Set());

    expect(holder).toMatchObject({ LANGFUSE_PUBLIC_KEY: 'pk' });
    expect(other).not.toHaveProperty('LANGFUSE_PUBLIC_KEY');
    expect(other).not.toHaveProperty('LANGFUSE_SECRET_KEY');
    // Unlisted secrets keep reaching every task, with or without a person.
    expect(other.OPENAI_API_KEY).toBe('open');
    expect(nobody).toEqual({ OPENAI_API_KEY: 'open' });
  });

  it('strips deployment AWS keys when the policy manages AWS, unless envVars lists them', () => {
    const roles = expandEntraRoles(policy, ['Kojo.AWS.Admin']);
    expect(
      filterEnvVarsForRoles(policy, DEPLOYMENT_ENV, roles),
    ).not.toHaveProperty('AWS_ACCESS_KEY_ID');

    const listed = parseRoleAccessPolicy(
      JSON.stringify({
        ...POLICY,
        envVars: { AWS_ACCESS_KEY_ID: ['Kojo.AWS.Admin'] },
      }),
    )!;
    expect(
      filterEnvVarsForRoles(listed, DEPLOYMENT_ENV, roles).AWS_ACCESS_KEY_ID,
    ).toBe('deployment-key');
  });

  it('gates listed MCP servers and leaves the rest open', () => {
    expect(isMcpServerAllowed(policy, 'notion', new Set())).toBe(false);
    expect(isMcpServerAllowed(policy, 'notion', new Set(['Kojo.Notion']))).toBe(
      true,
    );
    expect(isMcpServerAllowed(policy, 'linear', new Set())).toBe(true);
  });

  it('picks the first AWS role held, counting implied roles', () => {
    expect(
      selectAwsRole(policy, expandEntraRoles(policy, ['Kojo.AWS.Admin'])),
    ).toMatchObject({ roleArn: expect.stringContaining('kojo-aws-admin') });
    expect(
      selectAwsRole(policy, expandEntraRoles(policy, ['Kojo.AWS.ReadOnly'])),
    ).toMatchObject({ roleArn: expect.stringContaining('kojo-aws-readonly') });
    expect(selectAwsRole(policy, new Set(['Kojo.Langfuse']))).toBeNull();
    // Admin implies ReadOnly, so an admin-only policy entry is not needed.
    expect(expandEntraRoles(policy, ['Kojo.AWS.Admin'])).toEqual(
      new Set(['Kojo.AWS.Admin', 'Kojo.AWS.ReadOnly']),
    );
  });

  it('builds a valid STS session name from an email', () => {
    expect(toAwsRoleSessionName('Ada Lovelace+kojo@aeero.io')).toBe(
      'Ada-Lovelace+kojo@aeero.io',
    );
    expect(toAwsRoleSessionName(`${'a'.repeat(80)}@x.io`)).toHaveLength(64);
    expect(toAwsRoleSessionName(null)).toBe('kojo-task');
  });
});
