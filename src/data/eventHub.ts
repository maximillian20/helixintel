/**
 * One shared server-sent-events connection for the whole page. Browsers allow only about six connections per host,
 * so every component opening its own stream would starve ordinary requests.
 */
let source: EventSource | null = null;
let consumers = 0;

export function openSharedEvents() {
  if (!source) source = new EventSource('/api/events');
  consumers += 1;
  const added: Array<[string, EventListener]> = [];
  let closed = false;
  return {
    addEventListener(name: string, listener: () => void) {
      source?.addEventListener(name, listener);
      added.push([name, listener]);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [name, listener] of added) source?.removeEventListener(name, listener);
      consumers -= 1;
      if (consumers <= 0) {
        source?.close();
        source = null;
        consumers = 0;
      }
    },
  };
}
