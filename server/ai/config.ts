/**
 * AI connection settings. Everything comes from environment variables on the server; nothing here is ever sent to a browser.
 *
 * Two free routes are supported, and nothing else:
 *  - `ollama`: open-weight models on a computer you own (https://ollama.com), reached directly or through the authenticated gateway.
 *  - `cloudflare`: Cloudflare Workers AI on the Free plan (no install). The Free plan stops at its daily allowance with an error
 *    instead of charging, which is why it is allowed; the app refuses to use it if the host is anything but api.cloudflare.com.
 * There is deliberately no setting for a paid provider, and well-known paid API hosts are refused outright.
 */

export type AiProvider = 'ollama' | 'cloudflare';

export type AutoEnrich = 'off' | 'critical-high' | 'all';

export type AiConfig = {
  /** AI_ENABLED=0 switches every AI feature off for the whole installation. */
  enabled: boolean;
  provider: AiProvider;
  /**
   * May private workspace records (incidents, country assessments, saved places and assets) be put into prompts? Always true for
   * a model on your own computer. For Cloudflare it is false unless AI_ALLOW_PRIVATE_RECORDS=1, because those records would
   * leave your control. Public feed reports are always allowed.
   */
  privateRecords: boolean;
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  concurrency: number;
  queueLimit: number;
  numCtx: number;
  maxOutputTokens: number;
  autoEnrich: AutoEnrich;
  autoEnrichPerTick: number;
  /** Reasons the connection settings were rejected. Non-empty means "AI setup required". */
  problems: string[];
};

export const DEFAULT_MODEL = 'qwen3:4b';
export const DEFAULT_CLOUDFLARE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const CLOUDFLARE_HOST = 'api.cloudflare.com';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Hosts of paid AI APIs. The client speaks Ollama's protocol only, but refusing these makes the "no paid usage" rule explicit. */
const PAID_HOST_SUFFIXES = [
  'openai.com', 'anthropic.com', 'googleapis.com', 'mistral.ai', 'cohere.com', 'cohere.ai', 'x.ai', 'together.xyz', 'together.ai',
  'openrouter.ai', 'deepseek.com', 'perplexity.ai', 'azure.com', 'openai.azure.com', 'amazonaws.com', 'groq.com', 'fireworks.ai',
];

export function isLoopbackHost(hostname: string) {
  return LOOPBACK.has(hostname.toLowerCase());
}

export function isPaidHost(hostname: string) {
  const host = hostname.toLowerCase();
  return PAID_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function int(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function readAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const problems: string[] = [];
  const enabled = env.AI_ENABLED?.trim() !== '0';
  const rawUrl = env.AI_BASE_URL?.trim() || '';
  const apiKey = env.AI_API_KEY?.trim() || null;
  const providerRaw = env.AI_PROVIDER?.trim().toLowerCase() || '';
  if (providerRaw && providerRaw !== 'ollama' && providerRaw !== 'cloudflare') problems.push('AI_PROVIDER must be "ollama" or "cloudflare".');
  const provider: AiProvider = providerRaw === 'cloudflare' ? 'cloudflare' : 'ollama';
  const model = env.AI_MODEL?.trim() || (provider === 'cloudflare' ? DEFAULT_CLOUDFLARE_MODEL : DEFAULT_MODEL);
  let baseUrl: string | null = null;

  if (!/^[A-Za-z0-9._:/@-]{1,80}$/.test(model)) problems.push('AI_MODEL contains characters that are not allowed in a model name.');

  if (provider === 'cloudflare') {
    const accountId = env.AI_CLOUDFLARE_ACCOUNT_ID?.trim() || '';
    if (rawUrl) problems.push('AI_BASE_URL is not used with AI_PROVIDER=cloudflare. Remove it; the address is built from AI_CLOUDFLARE_ACCOUNT_ID.');
    if (!/^[0-9a-f]{32}$/i.test(accountId)) problems.push('Set AI_CLOUDFLARE_ACCOUNT_ID to your Cloudflare account ID (32 letters and digits).');
    else if (!apiKey) problems.push('Set AI_API_KEY to a Cloudflare API token that has the "Workers AI" permission.');
    else baseUrl = `https://${CLOUDFLARE_HOST}/client/v4/accounts/${accountId.toLowerCase()}/ai/v1`;
  } else if (rawUrl) {
    try {
      const url = new URL(rawUrl);
      const loopback = isLoopbackHost(url.hostname);
      if (url.username || url.password) problems.push('AI_BASE_URL must not contain a user name or password. Put the key in AI_API_KEY.');
      else if (isPaidHost(url.hostname)) problems.push(`AI_BASE_URL points to ${url.hostname}, a paid AI provider. Paid providers are disabled by design; use Ollama on your own computer.`);
      else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) problems.push('AI_BASE_URL must use https:// unless it points at this same machine (localhost). A plain http connection to another machine is not encrypted.');
      else if (!loopback && !apiKey) problems.push('AI_API_KEY is required for a remote model endpoint. An unauthenticated model endpoint must never be reachable from the internet.');
      else if (loopback && env.RENDER && env.NODE_ENV === 'production') problems.push('AI_BASE_URL points at localhost, which on Render means the Render server itself, not your computer. Use the https address of your tunnel.');
      else baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      problems.push('AI_BASE_URL is not a valid web address.');
    }
  }

  const autoRaw = env.AI_AUTO_ENRICH?.trim().toLowerCase();
  // A free hosted allowance is small, so automatic summaries are opt-in there.
  const autoEnrich: AutoEnrich = autoRaw === 'off' || autoRaw === 'all' || autoRaw === 'critical-high' ? autoRaw : provider === 'cloudflare' ? 'off' : 'critical-high';
  const privateRecords = provider === 'ollama' || env.AI_ALLOW_PRIVATE_RECORDS?.trim() === '1';

  return {
    enabled,
    provider,
    privateRecords,
    baseUrl: problems.length === 0 ? baseUrl : null,
    apiKey: problems.length === 0 ? apiKey : null,
    model,
    // CPU-only laptops can take a minute or more for a long answer, so the default is generous but bounded.
    timeoutMs: int(env.AI_TIMEOUT_MS, 180_000, 5_000, 600_000),
    concurrency: int(env.AI_CONCURRENCY, 1, 1, 4),
    queueLimit: int(env.AI_QUEUE_LIMIT, 8, 1, 50),
    numCtx: int(env.AI_NUM_CTX, 8192, 2048, 32768),
    maxOutputTokens: int(env.AI_MAX_OUTPUT_TOKENS, 1400, 200, 4000),
    autoEnrich,
    autoEnrichPerTick: int(env.AI_AUTO_ENRICH_PER_TICK, 3, 1, 20),
    problems,
  };
}
