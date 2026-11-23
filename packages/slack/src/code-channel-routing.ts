/**
 * Edge translation for Slack code channels, kept free of database imports so
 * SlackNotifier (which the client entry re-exports) stays usable anywhere.
 *
 * Inside Roomote a code channel session is the "thread" of its anchor
 * message: (channel, anchorTs). In Slack, people and the agent talk at the top
 * level of the channel. SlackNotifier asks this module whether a
 * (channel, thread_ts) pair is a code channel anchor, and if so posts
 * top-level instead. Server processes register a database-backed resolver
 * (see code-channels.ts); without one, nothing is translated and replies land
 * as thread replies under the anchor, still inside the code channel.
 */

export type SlackCodeChannelAnchorResolver = (
  channelId: string,
) => Promise<string | null>;

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 5_000;

let resolver: SlackCodeChannelAnchorResolver | null = null;
const cache = new Map<string, { anchorTs: string | null; expiresAt: number }>();

export function setSlackCodeChannelAnchorResolver(
  next: SlackCodeChannelAnchorResolver | null,
): void {
  resolver = next;
  cache.clear();
}

/** Prime the cache right after Roomote opens a channel, so the first replies
 * are translated without waiting on a lookup. */
export function rememberSlackCodeChannelAnchor(
  channelId: string,
  anchorTs: string,
): void {
  setCached(channelId, anchorTs);
}

export function forgetSlackCodeChannelAnchor(channelId: string): void {
  cache.delete(channelId);
}

function setCached(channelId: string, anchorTs: string | null): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(channelId, { anchorTs, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Synchronous answer when one is known without a lookup: the anchor, null
 * for an ordinary channel, or undefined when only the resolver can tell.
 * Lets hot read paths avoid yielding before they dedupe in-flight requests.
 */
export function peekSlackCodeChannelAnchor(
  channelId: string | undefined,
): string | null | undefined {
  if (!channelId) return null;
  const cached = cache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) return cached.anchorTs;
  return resolver ? undefined : null;
}

/** The anchor ts of a code channel, or null for any other channel. */
export async function resolveSlackCodeChannelAnchor(
  channelId: string | undefined,
): Promise<string | null> {
  if (!channelId) return null;

  const cached = cache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) return cached.anchorTs;

  if (!resolver) return null;

  try {
    const anchorTs = await resolver(channelId);
    setCached(channelId, anchorTs);
    return anchorTs;
  } catch (error) {
    console.warn(
      `[SlackCodeChannels] Anchor lookup failed for channel ${channelId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** True when a post addressed to (channel, threadTs) belongs at the top level
 * of a code channel. */
export async function isSlackCodeChannelAnchorThread(
  channelId: string | undefined,
  threadTs: string | undefined,
): Promise<boolean> {
  if (!channelId || !threadTs) return false;
  const anchorTs = await resolveSlackCodeChannelAnchor(channelId);
  return anchorTs !== null && anchorTs === threadTs;
}
