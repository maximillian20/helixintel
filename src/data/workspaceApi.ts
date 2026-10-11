import { useCallback, useEffect, useRef, useState } from 'react';
import { openSharedEvents } from './eventHub';
import { getClientId } from './feedApi';

const nameKey = 'gsi-analyst-name';

export function getAnalystName() {
  try {
    return window.localStorage.getItem(nameKey) ?? '';
  } catch {
    return '';
  }
}

export function setAnalystName(name: string) {
  try {
    if (name.trim()) window.localStorage.setItem(nameKey, name.trim());
    else window.localStorage.removeItem(nameKey);
  } catch {
    // storage unavailable: the server falls back to a browser label
  }
}

export async function wsFetch<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { 'X-Client-Id': getClientId() };
  const name = getAnalystName();
  if (name) headers['X-Analyst-Name'] = name.replace(/[^\x20-\x7E]/g, '');
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/workspace${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // no body
  }
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `The server returned HTTP ${response.status}.`);
  return data as T;
}

const refreshEvents = ['workspace-updated', 'public-feed-updated', 'source-sync-updated', 'alerts-updated'];

/**
 * Loads workspace data and reloads it when the server reports stored changes. The previous data stays on screen if a reload fails,
 * and `lastLoadedAt` says when it was actually retrieved.
 */
export function useWorkspaceData<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(path !== null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const current = pathRef.current;
    if (current === null) return;
    const id = ++requestId.current;
    try {
      const result = await wsFetch<T>('GET', current);
      if (id !== requestId.current || pathRef.current !== current) return;
      setData(result);
      setError('');
      setLastLoadedAt(new Date().toISOString());
    } catch (caught) {
      if (id !== requestId.current) return;
      setError(caught instanceof Error ? caught.message : 'Could not load data.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    void load();
    return undefined;
  }, [path, load]);

  useEffect(() => {
    const events = openSharedEvents();
    let timer: number | undefined;
    const reloadSoon = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 400);
    };
    for (const name of refreshEvents) events.addEventListener(name, reloadSoon);
    const interval = window.setInterval(() => void load(), 60_000);
    return () => {
      events.close();
      window.clearInterval(interval);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [load]);

  return { data, error, loading, reload: load, lastLoadedAt };
}
