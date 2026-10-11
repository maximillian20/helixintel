import { useCallback, useEffect, useRef, useState } from 'react';
import { openSharedEvents } from './eventHub';
import { getClientId } from './feedApi';
import { getAnalystName } from './workspaceApi';

export async function marketFetch<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Client-Id': getClientId() };
  const name = getAnalystName();
  if (name) headers['X-Analyst-Name'] = name.replace(/[^\x20-\x7E]/g, '');
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/market${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: unknown = null;
  try { data = await response.json(); } catch { /* no body */ }
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `The server returned HTTP ${response.status}.`);
  return data as T;
}

const refreshEvents = ['market-updated', 'public-feed-updated', 'workspace-updated'];

/** Loads market data, reloads on server events and every 60 s, and keeps the previous data on screen if a reload fails. */
export function useMarketData<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(path !== null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const current = pathRef.current;
    if (current === null) return;
    const id = ++requestId.current;
    try {
      const result = await marketFetch<T>('GET', current);
      if (id !== requestId.current || pathRef.current !== current) return;
      setData(result);
      setError('');
    } catch (caught) {
      if (id === requestId.current) setError(caught instanceof Error ? caught.message : 'Could not load data.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (path === null) { setData(null); setLoading(false); return; }
    setLoading(true);
    void load();
  }, [path, load]);

  useEffect(() => {
    const events = openSharedEvents();
    let timer: number | undefined;
    const reloadSoon = () => { if (timer !== undefined) window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 400); };
    for (const name of refreshEvents) events.addEventListener(name, reloadSoon);
    const interval = window.setInterval(() => void load(), 60_000);
    return () => { events.close(); window.clearInterval(interval); if (timer !== undefined) window.clearTimeout(timer); };
  }, [load]);

  return { data, error, loading, reload: load };
}
