import type { ZodType, ZodTypeDef } from 'zod';
import type { AiConfig } from './config';
import type { AiMeta, AiState, AiStatusDto } from '../../src/data/aiTypes';

/**
 * The one AI client shared by every module. It talks to a single configured endpoint (Ollama on your own computer, or Cloudflare
 * Workers AI on the Free plan), one request at a time by default, with timeouts, a bounded queue, cancellation and at most one
 * repair retry. It never falls back to another provider.
 */

export class AiUnavailableError extends Error {
  constructor(readonly state: AiState, message: string) {
    super(message);
  }
}
export class AiBusyError extends Error {}
export class AiCancelledError extends Error {}
export class AiOutputError extends Error {}
export class AiTimeoutError extends Error {}
/** The request needs private records, and this installation does not allow sending them to the configured AI service. */
export class AiPrivacyError extends Error {}

export type GenerateOptions<T> = {
  task: string;
  system: string;
  user: string;
  schema: ZodType<T, ZodTypeDef, unknown>;
  /** JSON Schema given to Ollama's `format` field so the runtime constrains the output. */
  jsonSchema: Record<string, unknown>;
  signal?: AbortSignal;
  maxTokens?: number;
  /** Overrides the default timeout for quick interactive tasks. */
  timeoutMs?: number;
  /** Extra checks on the parsed value; a thrown message is fed back once for repair. */
  check?: (value: T) => void;
};

export type Generated<T> = { value: T; meta: Omit<AiMeta, 'promptVersion'> };

type Fetcher = typeof fetch;

const STATUS_TTL_MS = 20_000;

function stripThinking(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export class AiService {
  private cached: { at: number; status: Omit<AiStatusDto, 'queue' | 'counters' | 'userEnabled' | 'paidProviderCalls' | 'autoEnrich' | 'provider' | 'privateRecords' | 'usage'> } | null = null;
  private running = 0;
  private waiters: Array<{ grant: () => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void }> = [];
  readonly counters = { generated: 0, cacheHits: 0, failures: 0, timeouts: 0, rejectedInvalid: 0 };
  /** Every host this service has sent a request to. Tests assert it only ever contains the configured endpoint. */
  readonly contactedHosts = new Set<string>();

  constructor(
    readonly config: AiConfig,
    private readonly fetcher: Fetcher = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get model() {
    return this.config.model;
  }

  /** Version string used in cache keys: model name plus the digest the runtime reported. */
  get modelVersion() {
    if (this.config.provider === 'cloudflare') return `${this.config.model}@cloudflare`;
    return `${this.config.model}@${this.cached?.status.modelDigest ?? 'unknown'}`;
  }

  private headers(json = false) {
    const headers: Record<string, string> = {};
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private send(path: string, init: RequestInit) {
    const base = this.config.baseUrl!;
    this.contactedHosts.add(new URL(base).host);
    return this.fetcher(`${base}${path}`, { ...init, redirect: 'error' });
  }

  /** Set by a failed hosted request so the status stays honest until it is worth trying again. */
  private hostedProblem: { until: number; status: Pick<NonNullable<AiService['cached']>['status'], 'state' | 'message' | 'steps'> } | null = null;
  /** Hosted JSON schema mode was refused for this model once; later requests ask for plain JSON instead. */
  private hostedNoSchema = false;
  readonly usage = { day: '', requests: 0, promptTokens: 0, completionTokens: 0 };

  private noteUsage(body: { usage?: { prompt_tokens?: number; completion_tokens?: number } }) {
    const day = this.clock().toISOString().slice(0, 10);
    if (this.usage.day !== day) Object.assign(this.usage, { day, requests: 0, promptTokens: 0, completionTokens: 0 });
    this.usage.requests += 1;
    this.usage.promptTokens += Number(body.usage?.prompt_tokens) || 0;
    this.usage.completionTokens += Number(body.usage?.completion_tokens) || 0;
  }

  private nextUtcMidnight() {
    const now = this.clock();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  }

  /** Current connection state. Cached briefly so page loads do not each probe the model host. */
  async status(force = false): Promise<Omit<AiStatusDto, 'userEnabled'>> {
    const now = this.clock().getTime();
    if (!force && this.cached && now - this.cached.at < STATUS_TTL_MS) return this.compose(this.cached.status);
    const status = await this.probe();
    this.cached = { at: now, status };
    return this.compose(status);
  }

  private compose(base: NonNullable<AiService['cached']>['status']): Omit<AiStatusDto, 'userEnabled'> {
    return {
      ...base,
      provider: this.config.provider,
      privateRecords: this.config.privateRecords,
      usage: this.config.provider === 'cloudflare' ? { ...this.usage } : null,
      queue: { running: this.running, waiting: this.waiters.length, limit: this.config.queueLimit, concurrency: this.config.concurrency },
      counters: { ...this.counters },
      paidProviderCalls: 0,
      autoEnrich: this.config.autoEnrich,
    };
  }

  private async probe(): Promise<NonNullable<AiService['cached']>['status']> {
    const now = () => this.clock().getTime();
    const checkedAt = this.clock().toISOString();
    const base = { model: this.config.model, modelDigest: null as string | null, endpoint: null as string | null, checkedAt };
    if (!this.config.enabled) return { ...base, state: 'disabled', message: 'AI features are switched off on this server (AI_ENABLED=0).', steps: [] };
    if (this.config.problems.length > 0) return { ...base, state: 'setup_required', message: 'AI setup required. The connection settings were rejected.', steps: this.config.problems };
    if (!this.config.baseUrl) {
      return {
        ...base, state: 'setup_required', message: 'AI setup required. No model is connected, so AI features are off. Everything else works normally.',
        steps: [
          'Easiest, nothing to install: create a free Cloudflare account, make an API token with the "Workers AI" permission, then on the server set AI_PROVIDER=cloudflare, AI_CLOUDFLARE_ACCOUNT_ID and AI_API_KEY (see docs/AI.md).',
          'Or, on a computer you own: install Ollama, run "ollama pull ' + this.config.model + '", expose it through the authenticated gateway and set AI_BASE_URL and AI_API_KEY.',
        ],
      };
    }
    const endpoint = new URL(this.config.baseUrl).host;
    if (this.config.provider === 'cloudflare') {
      if (this.hostedProblem && this.hostedProblem.until > now()) return { ...base, endpoint, ...this.hostedProblem.status };
      return {
        ...base, endpoint, state: 'ready',
        message: `Cloudflare Workers AI (free plan), model ${this.config.model}. The connection is verified by the first request. The free plan allows 10,000 neurons per day and then stops; it never charges.`, steps: [],
      };
    }
    try {
      const response = await this.send('/api/tags', { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(8000) });
      if (response.status === 401 || response.status === 403) {
        return { ...base, endpoint, state: 'unreachable', message: 'The model endpoint rejected the key (HTTP ' + response.status + ').', steps: ['Check that AI_API_KEY on the server matches the key the gateway was started with.'] };
      }
      if (!response.ok) return { ...base, endpoint, state: 'unreachable', message: `The model endpoint answered HTTP ${response.status}.`, steps: ['Check that Ollama and the gateway are running on your computer.'] };
      const body = (await response.json()) as { models?: Array<{ name?: string; model?: string; digest?: string }> };
      const wanted = this.config.model;
      const match = (body.models ?? []).find((entry) => [entry.name, entry.model].some((name) => name === wanted || name === `${wanted}:latest`));
      if (!match) {
        return { ...base, endpoint, state: 'model_missing', message: `Connected, but the model "${wanted}" is not installed there.`, steps: [`On the computer running Ollama: ollama pull ${wanted}`] };
      }
      return { ...base, endpoint, modelDigest: match.digest ? String(match.digest).slice(0, 12) : null, state: 'ready', message: `Connected to ${endpoint}. Model: ${wanted}.`, steps: [] };
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return {
        ...base, endpoint, state: 'unreachable',
        message: timedOut ? 'The model endpoint did not answer in time. Your computer may be asleep, off or offline.' : 'The model endpoint could not be reached. Your computer may be asleep, off or offline.',
        steps: ['Wake the computer running Ollama and make sure the tunnel and gateway are running.'],
      };
    }
  }

  private invalidateStatus() {
    this.cached = null;
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    const release = () => {
      this.running -= 1;
      const next = this.waiters.shift();
      if (next) {
        if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
        this.running += 1;
        next.grant();
      }
    };
    if (signal?.aborted) return Promise.reject(new AiCancelledError('Cancelled.'));
    if (this.running < this.config.concurrency) {
      this.running += 1;
      return Promise.resolve(release);
    }
    if (this.waiters.length >= this.config.queueLimit) return Promise.reject(new AiBusyError('The AI queue is full. Try again in a moment.'));
    return new Promise((resolve, reject) => {
      const waiter: AiService['waiters'][number] = { grant: () => resolve(release), reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          reject(new AiCancelledError('Cancelled.'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** Generates structured output. Throws AiUnavailableError (no usable model), AiBusyError, AiCancelledError, AiTimeoutError or AiOutputError. */
  async generate<T>(options: GenerateOptions<T>): Promise<Generated<T>> {
    const status = await this.status();
    if (status.state !== 'ready') throw new AiUnavailableError(status.state, status.message);
    const release = await this.acquire(options.signal);
    const started = this.clock().getTime();
    try {
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: options.system },
        { role: 'user', content: options.user },
      ];
      let attempts = 0;
      let lastProblem = '';
      while (attempts < 2) {
        attempts += 1;
        const text = await this.chat(messages, options);
        try {
          const parsed = options.schema.parse(JSON.parse(stripThinking(text)));
          options.check?.(parsed);
          this.counters.generated += 1;
          return { value: parsed, meta: { model: this.config.model, modelDigest: this.cached?.status.modelDigest ?? null, generatedAt: this.clock().toISOString(), durationMs: this.clock().getTime() - started, attempts } };
        } catch (error) {
          this.counters.rejectedInvalid += 1;
          lastProblem = error instanceof Error ? error.message.slice(0, 400) : 'invalid output';
          messages.push({ role: 'assistant', content: text.slice(0, 4000) });
          messages.push({ role: 'user', content: `That reply was rejected: ${lastProblem}\nReply again with corrected JSON only. Use only the evidence provided.` });
        }
      }
      this.counters.failures += 1;
      throw new AiOutputError(`The model did not return a valid answer (${lastProblem}).`);
    } finally {
      release();
    }
  }

  private async chat(messages: Array<{ role: string; content: string }>, options: { jsonSchema: Record<string, unknown>; signal?: AbortSignal; maxTokens?: number; timeoutMs?: number }): Promise<string> {
    const signals = [AbortSignal.timeout(options.timeoutMs ?? this.config.timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    try {
      return this.config.provider === 'cloudflare' ? await this.chatHosted(messages, options, signal) : await this.chatOllama(messages, options, signal);
    } catch (error) {
      if (error instanceof AiUnavailableError || error instanceof AiOutputError || error instanceof AiBusyError) throw error;
      if (options.signal?.aborted) throw new AiCancelledError('Cancelled.');
      this.invalidateStatus();
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        this.counters.timeouts += 1;
        throw new AiTimeoutError(`The model took longer than ${Math.round((options.timeoutMs ?? this.config.timeoutMs) / 1000)} seconds. Try a shorter question or a smaller model.`);
      }
      this.counters.failures += 1;
      throw new AiUnavailableError('unreachable', this.config.provider === 'cloudflare' ? 'Cloudflare Workers AI could not be reached.' : 'The model endpoint could not be reached. Your computer may be asleep, off or offline.');
    }
  }

  private async chatOllama(messages: Array<{ role: string; content: string }>, options: { jsonSchema: Record<string, unknown>; maxTokens?: number }, signal: AbortSignal): Promise<string> {
    const response = await this.send('/api/chat', {
      method: 'POST',
      headers: this.headers(true),
      signal,
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: false,
        think: false,
        format: options.jsonSchema,
        options: { temperature: 0.2, num_ctx: this.config.numCtx, num_predict: options.maxTokens ?? this.config.maxOutputTokens },
        keep_alive: '10m',
      }),
    });
    if (!response.ok) {
      this.counters.failures += 1;
      if (response.status === 401 || response.status === 403) this.invalidateStatus();
      throw new AiUnavailableError('unreachable', `The model endpoint answered HTTP ${response.status}.`);
    }
    const body = (await response.json()) as { message?: { content?: string } };
    const content = body.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new AiOutputError('The model returned an empty answer.');
    return content;
  }

  /** Cloudflare Workers AI, OpenAI-compatible chat completions. Free plan only: the daily allowance ends with an error, never a charge. */
  private async chatHosted(messages: Array<{ role: string; content: string }>, options: { jsonSchema: Record<string, unknown>; maxTokens?: number }, signal: AbortSignal): Promise<string> {
    const request = (withSchema: boolean) => this.send('/chat/completions', {
      method: 'POST',
      headers: this.headers(true),
      signal,
      body: JSON.stringify({
        model: this.config.model, messages, stream: false, temperature: 0.2, max_tokens: options.maxTokens ?? this.config.maxOutputTokens,
        ...(withSchema ? { response_format: { type: 'json_schema', json_schema: options.jsonSchema } } : {}),
      }),
    });
    let response = await request(!this.hostedNoSchema);
    if (response.status === 400 && !this.hostedNoSchema) {
      // This model does not accept JSON schema mode. Ask for plain JSON (the prompt already says so); the app validates it anyway.
      this.hostedNoSchema = true;
      response = await request(false);
    }
    if (!response.ok) {
      this.counters.failures += 1;
      const text = (await response.text().catch(() => '')).slice(0, 600);
      const reset = this.nextUtcMidnight();
      if (response.status === 401 || response.status === 403) {
        this.hostedProblem = { until: this.clock().getTime() + 5 * 60_000, status: { state: 'unreachable', message: `Cloudflare rejected the API token (HTTP ${response.status}).`, steps: ['Create an API token with the "Workers AI" permission and check AI_API_KEY and AI_CLOUDFLARE_ACCOUNT_ID on the server.'] } };
        this.invalidateStatus();
        throw new AiUnavailableError('unreachable', this.hostedProblem.status.message);
      }
      if (response.status === 429 || /daily|neurons|4006|allocation|quota/i.test(text)) {
        if (/daily|neurons|4006|allocation|quota/i.test(text)) {
          const message = 'The free daily allowance of Cloudflare Workers AI (10,000 neurons) is used up. It resets at 00:00 UTC. Nothing was charged.';
          this.hostedProblem = { until: reset, status: { state: 'limit_reached', message, steps: ['Wait until 00:00 UTC, or use a smaller model (AI_MODEL=@cf/qwen/qwen3-30b-a3b-fp8 or @cf/meta/llama-3.1-8b-instruct-fp8-fast) so the allowance goes further.'] } };
          this.invalidateStatus();
          throw new AiUnavailableError('limit_reached', message);
        }
        throw new AiBusyError('Cloudflare is rate limiting requests. Try again in a minute.');
      }
      throw new AiUnavailableError('unreachable', `Cloudflare Workers AI answered HTTP ${response.status}.${response.status === 404 ? ' Check the model name in AI_MODEL.' : ''}`);
    }
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    this.noteUsage(body);
    const raw = body.choices?.[0]?.message?.content;
    const content = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : '';
    if (!content.trim()) throw new AiOutputError('The model returned an empty answer.');
    return content;
  }
}
