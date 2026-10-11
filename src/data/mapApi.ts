import { useCallback, useEffect, useRef, useState } from 'react';
import { openSharedEvents } from './eventHub';
import { getClientId } from './feedApi';
import { resolveRange, type Bounds } from './mapLogic';
import type { AircraftResponse, MapConfig, MapDataResponse, MapFilters } from './mapTypes';

export async function mapFetch<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Client-Id': getClientId() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/map${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: unknown = null;
  try { data = await response.json(); } catch { /* no body */ }
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `The server returned HTTP ${response.status}.`);
  return data as T;
}

const refreshEvents = ['map-updated', 'public-feed-updated', 'workspace-updated'];

/** Generic loader for map endpoints: reloads on server events, keeps previous data on screen when a reload fails. */
export function useMapResource<T>(path: string | null, options: { poll?: boolean } = {}) {
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
      const result = await mapFetch<T>('GET', current);
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
    if (!options.poll) return undefined;
    const events = openSharedEvents();
    let timer: number | undefined;
    const reloadSoon = () => { if (timer !== undefined) window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 400); };
    for (const name of refreshEvents) events.addEventListener(name, reloadSoon);
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { events.close(); window.clearInterval(interval); if (timer !== undefined) window.clearTimeout(timer); };
  }, [load, options.poll]);

  return { data, error, loading, reload: load };
}

/**
 * Event data for the chosen time range. The range is recomputed on every load, so "last 24 hours" always means the last
 * 24 hours from now, while the request path only changes when the person changes the range.
 */
export function useMapData(filters: Pick<MapFilters, 'preset' | 'customFrom' | 'customTo'>) {
  const [data, setData] = useState<MapDataResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const requestId = useRef(0);
  const key = `${filters.preset}|${filters.customFrom}|${filters.customTo}`;

  const load = useCallback(async () => {
    const id = ++requestId.current;
    const range = resolveRange(filtersRef.current, Date.now());
    try {
      const result = await mapFetch<MapDataResponse>('GET', `/data?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`);
      if (id !== requestId.current) return;
      setData(result);
      setError('');
    } catch (caught) {
      if (id === requestId.current) setError(caught instanceof Error ? caught.message : 'Could not load map data.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => { setLoading(true); void load(); }, [key, load]);
  useEffect(() => {
    const events = openSharedEvents();
    let timer: number | undefined;
    const reloadSoon = () => { if (timer !== undefined) window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 400); };
    for (const name of refreshEvents) events.addEventListener(name, reloadSoon);
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { events.close(); window.clearInterval(interval); if (timer !== undefined) window.clearTimeout(timer); };
  }, [load]);

  return { data, error, loading, reload: load };
}

export type AircraftState = {
  data: AircraftResponse | null;
  error: string;
  loading: boolean;
  /** Number of requests this hook has sent; useful to confirm polling stops when the layer is off or the page is hidden. */
  requests: number;
};

/**
 * Polls aircraft for the visible box only. Movement is debounced; nothing is requested while the layer is disabled, the
 * page is hidden or no box is known. Each cycle waits the provider-safe refresh interval from the server config.
 */
export function useAircraft(enabled: boolean, bounds: Bounds | null, refreshMs: number, debounceMs = 600): AircraftState {
  const [state, setState] = useState<AircraftState>({ data: null, error: '', loading: false, requests: 0 });
  const boundsKey = bounds ? bounds.map((n) => n.toFixed(2)).join(',') : '';
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  useEffect(() => {
    if (!enabled || !boundsKey) { setState((s) => (s.data || s.error || s.loading ? { ...s, data: null, error: '', loading: false } : s)); return undefined; }
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const run = async () => {
      timer = undefined;
      if (cancelled || document.hidden) return;
      const box = boundsRef.current;
      if (!box) return;
      controller?.abort();
      controller = new AbortController();
      setState((s) => ({ ...s, loading: true, requests: s.requests + 1 }));
      try {
        const query = `south=${box[0]}&west=${box[1]}&north=${box[2]}&east=${box[3]}`;
        const response = await fetch(`/api/map/aircraft?${query}`, { headers: { 'X-Client-Id': getClientId() }, signal: controller.signal });
        const body = await response.json() as AircraftResponse & { error?: string };
        if (cancelled) return;
        if (!response.ok) throw new Error(body.error ?? `The server returned HTTP ${response.status}.`);
        setState((s) => ({ ...s, data: body, error: '', loading: false }));
      } catch (caught) {
        if (cancelled || (caught instanceof DOMException && caught.name === 'AbortError')) return;
        setState((s) => ({ ...s, error: caught instanceof Error ? caught.message : 'Could not load aircraft.', loading: false }));
      }
      if (!cancelled) timer = window.setTimeout(() => void run(), refreshMs);
    };

    const onVisibility = () => {
      if (document.hidden) { if (timer !== undefined) window.clearTimeout(timer); timer = undefined; controller?.abort(); }
      else if (timer === undefined) void run();
    };
    document.addEventListener('visibilitychange', onVisibility);
    timer = window.setTimeout(() => void run(), debounceMs);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [enabled, boundsKey, refreshMs, debounceMs]);

  return state;
}

export type { MapConfig };
