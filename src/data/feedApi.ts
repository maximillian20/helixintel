import { buildFeedQueryString, type FeedFilters, type FeedItemDto, type FeedPage, type Severity } from './feedTypes';

const storageKey = 'gsi-client-id';
let memoryId = '';

function randomId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** An anonymous, per-browser identifier. The app has no sign-in, so review and watchlist state is kept per browser. */
export function getClientId() {
  if (memoryId) return memoryId;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) {
      memoryId = stored;
      return memoryId;
    }
    memoryId = randomId();
    window.localStorage.setItem(storageKey, memoryId);
  } catch {
    memoryId = memoryId || randomId();
  }
  return memoryId;
}

async function readError(response: Response) {
  try {
    const body = await response.json() as { error?: string };
    if (body.error) return body.error;
  } catch {
    // not JSON
  }
  return `The server returned HTTP ${response.status}.`;
}

export async function fetchFeedPage(filters: FeedFilters, page: number, pageSize: number, signal?: AbortSignal): Promise<FeedPage> {
  const response = await fetch(`/api/feed/items?${buildFeedQueryString(filters, page, pageSize)}`, {
    headers: { 'X-Client-Id': getClientId() },
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  return await response.json() as FeedPage;
}

export type ItemStateChange = {
  reviewStatus?: 'Reviewed' | 'Unreviewed';
  watchlisted?: boolean;
  severityOverride?: Severity | null;
};

export async function saveItemState(articleId: string, change: ItemStateChange): Promise<{ item: FeedItemDto; watchlistTotal: number }> {
  const response = await fetch('/api/feed/state', {
    method: 'PATCH',
    headers: { 'X-Client-Id': getClientId(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ articleId, ...change }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return await response.json() as { item: FeedItemDto; watchlistTotal: number };
}

export type OverviewPayload = { items: FeedItemDto[]; total: number; returned: number; unlocated: number };

/** The same report model as the Intelligence Feed, for the Overview headlines and map. */
export async function fetchOverview(signal?: AbortSignal): Promise<OverviewPayload> {
  const response = await fetch('/api/feed/overview', { headers: { 'X-Client-Id': getClientId() }, signal });
  if (!response.ok) throw new Error(await readError(response));
  return await response.json() as OverviewPayload;
}
