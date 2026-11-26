import {
  and,
  asc,
  db,
  desc,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  githubUserMappings,
  inArray,
  isNotNull,
  sql,
  taskMessages,
  tasks,
  type TaskRun,
} from '@roomote/db/server';
import { Schemas as GitHubSchemas } from '@roomote/github';

type GitHubIdentity = { githubLogin: string; githubUserId: number };

/**
 * Who gets credit on a pull request Kojo opens: the person the run acts for
 * first, then everyone else who wrote into the task's conversation, in the
 * order they joined. People without a linked GitHub account are skipped, as
 * are bots, and each GitHub account appears once.
 */
export function deriveGitHubCoAuthors({
  participantUserIds,
  identities,
  isExcludedLogin = () => false,
}: {
  /** Ordered: the acting user first, then the rest by first message. */
  participantUserIds: Array<string | null | undefined>;
  identities: ReadonlyMap<string, GitHubIdentity>;
  isExcludedLogin?: (login: string) => boolean;
}): GitHubIdentity[] {
  const seen = new Set<number>();
  const coAuthors: GitHubIdentity[] = [];
  for (const userId of participantUserIds) {
    const identity = userId ? identities.get(userId) : undefined;
    if (
      !identity ||
      seen.has(identity.githubUserId) ||
      /\[bot\]$/i.test(identity.githubLogin) ||
      isExcludedLogin(identity.githubLogin)
    ) {
      continue;
    }
    seen.add(identity.githubUserId);
    coAuthors.push(identity);
  }
  return coAuthors;
}

/**
 * The login stands in for the name: it is already public, so a trailer in a
 * public repository never exposes a private display name. GitHub matches the
 * co-author by the noreply address either way.
 */
export function formatCoAuthorTrailer(identity: GitHubIdentity): string {
  return `Co-authored-by: ${identity.githubLogin} <${identity.githubUserId}+${identity.githubLogin}@users.noreply.github.com>`;
}

const NOREPLY_CO_AUTHOR_LINE =
  /^Co-authored-by: [^<\n]+ <\d+\+[^@\s]+@users\.noreply\.github\.com>$/i;

/**
 * Ends the body with the current co-author trailers, replacing any noreply
 * co-author trailers a previous write left at the end, so a refresh never
 * stacks duplicates or keeps someone the list no longer names.
 */
export function withCoAuthorTrailers(body: string, trailers: string[]): string {
  const lines = body.trimEnd().split('\n');
  while (
    lines.length > 0 &&
    NOREPLY_CO_AUTHOR_LINE.test(lines[lines.length - 1]!.trim())
  ) {
    lines.pop();
  }
  const rest = lines.join('\n').trimEnd();
  if (trailers.length === 0) {
    return rest;
  }
  if (!rest) {
    return trailers.join('\n');
  }
  // Join an existing trailer block so git reads them as one.
  const separator = /^(?:co-authored-by|signed-off-by):/i.test(
    rest.slice(rest.lastIndexOf('\n') + 1),
  )
    ? '\n'
    : '\n\n';
  return `${rest}${separator}${trailers.join('\n')}`;
}

/**
 * Co-author trailers for a task: the acting user, the person who started it,
 * and everyone who sent a message into it, minus `excludeGitHubUserId` (the
 * commit's own author, who needs no trailer on their own commit).
 */
export async function resolveTaskGitHubCoAuthorTrailers(
  taskRun: Pick<TaskRun, 'taskId' | 'actingUserId'>,
  options: { excludeGitHubUserId?: number | null } = {},
): Promise<string[]> {
  const [task, senders] = await Promise.all([
    db.query.tasks.findFirst({
      where: eq(tasks.id, taskRun.taskId),
      columns: { initiatorUserId: true },
    }),
    db
      .select({ userId: taskMessages.userId })
      .from(taskMessages)
      .where(
        and(
          eq(taskMessages.taskId, taskRun.taskId),
          eq(taskMessages.role, 'user'),
          isNotNull(taskMessages.userId),
        ),
      )
      .orderBy(asc(taskMessages.ts)),
  ]);

  return resolveGitHubCoAuthorTrailers(
    [
      taskRun.actingUserId,
      task?.initiatorUserId,
      ...senders.map((sender) => sender.userId),
    ],
    options,
  );
}

/**
 * Co-author trailers for a write made from a conversation (a Slack thread or
 * the web chat) through the GitHub tools rather than a coding task: the person
 * making the call, the conversation's owner, and everyone who wrote into it.
 */
export async function resolveConversationGitHubCoAuthorTrailers({
  actingUserId,
  conversationId,
}: {
  actingUserId: string | null | undefined;
  conversationId: string | null | undefined;
}): Promise<string[]> {
  const [conversation, senders] = conversationId
    ? await Promise.all([
        db.query.fastAgentConversations.findFirst({
          where: eq(fastAgentConversations.id, conversationId),
          columns: { userId: true },
        }),
        db
          .select({
            userId: sql<
              string | null
            >`${fastAgentMessages.metadata} ->> 'userId'`,
          })
          .from(fastAgentMessages)
          .where(
            and(
              eq(fastAgentMessages.conversationId, conversationId),
              eq(fastAgentMessages.role, 'user'),
            ),
          )
          .orderBy(asc(fastAgentMessages.ts)),
      ])
    : [undefined, []];

  return resolveGitHubCoAuthorTrailers([
    actingUserId,
    conversation?.userId,
    ...senders.map((sender) => sender.userId),
  ]);
}

async function resolveGitHubCoAuthorTrailers(
  participantUserIds: Array<string | null | undefined>,
  options: { excludeGitHubUserId?: number | null } = {},
): Promise<string[]> {
  const userIds = [
    ...new Set(participantUserIds.filter((id): id is string => Boolean(id))),
  ];
  if (userIds.length === 0) {
    return [];
  }

  const mappings = await db.query.githubUserMappings.findMany({
    where: inArray(githubUserMappings.userId, userIds),
    orderBy: [desc(githubUserMappings.updatedAt)],
    columns: { userId: true, githubLogin: true, githubUserId: true },
  });
  const identities = new Map<string, GitHubIdentity>();
  for (const mapping of mappings) {
    const githubLogin = mapping.githubLogin?.trim();
    // Newest first: keep each user's latest linked account.
    if (githubLogin && !identities.has(mapping.userId)) {
      identities.set(mapping.userId, {
        githubLogin,
        githubUserId: mapping.githubUserId,
      });
    }
  }

  return deriveGitHubCoAuthors({
    participantUserIds,
    identities,
    isExcludedLogin: GitHubSchemas.isManagedRoomoteGitHubLogin,
  })
    .filter((identity) => identity.githubUserId !== options.excludeGitHubUserId)
    .map(formatCoAuthorTrailer);
}
