import { useCallback, useEffect, useRef, useState } from 'react';
import { getAnalystName } from './workspaceApi';
import { getClientId } from './feedApi';
import type { AiStatusDto } from './aiTypes';

export class AiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly aiState?: string) {
    super(message);
  }
}

/** Calls /api/ai. AI errors keep their HTTP status and the AI state so the screen can say "AI setup required" instead of a generic failure. */
export async function aiFetch<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { 'X-Client-Id': getClientId() };
  const name = getAnalystName();
  if (name) headers['X-Analyst-Name'] = name.replace(/[^\x20-\x7E]/g, '');
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/ai${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // no body
  }
  if (!response.ok) {
    const payload = data as { error?: string; aiState?: string } | null;
    throw new AiRequestError(payload?.error ?? `The server returned HTTP ${response.status}.`, response.status, payload?.aiState);
  }
  return data as T;
}

/** AI status, refreshed every 30 seconds and after a failed request. */
export function useAiStatus() {
  const [status, setStatus] = useState<AiStatusDto | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setStatus(await aiFetch<AiStatusDto>('GET', '/status'));
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read the AI status.');
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);
  return { status, error, reload: load, ready: status?.state === 'ready' && status.userEnabled };
}

/** Runs one AI request at a time, with a Cancel that really aborts the request (the server then frees the model). */
export function useAiRun<T>() {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const run = useCallback(async (method: string, path: string, body?: unknown) => {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    setRunning(true);
    setError(null);
    try {
      const result = await aiFetch<T>(method, path, body, mine.signal);
      if (controller.current === mine) setData(result);
      return result;
    } catch (caught) {
      if (mine.signal.aborted) return null;
      if (controller.current === mine) setError(caught instanceof AiRequestError ? caught : new AiRequestError(caught instanceof Error ? caught.message : 'Request failed.', 0));
      return null;
    } finally {
      if (controller.current === mine) setRunning(false);
    }
  }, []);
  const cancel = useCallback(() => { controller.current?.abort(); setRunning(false); }, []);
  return { data, setData, error, running, run, cancel };
}
