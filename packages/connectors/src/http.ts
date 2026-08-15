import { loadEnv, sleep, type HttpClient, type HttpRequestOptions, type HttpResponse, type Logger } from '@elessar/core';

/**
 * The HTTP client every connector shares.
 *
 * Elessar lives entirely on free, public, mostly volunteer-run infrastructure.
 * Being a rude client is both an ethical problem and a practical one — GDELT
 * hands out HTTP 429 for more than one request every five seconds, and
 * api.weather.gov blocks generic user agents outright. So politeness is built
 * into the transport rather than left to each connector to remember:
 *
 *   - per-host serialized queue with a configurable minimum gap
 *   - exponential backoff with jitter, and Retry-After honoured when present
 *   - conditional requests (ETag / If-Modified-Since), surfacing 304 as data
 *     rather than as an error
 *   - a real User-Agent with a contact address
 *
 * Retries cover only transport errors and 5xx/429. A 4xx is a bug in the
 * connector, and retrying it just launders the mistake into a slow failure.
 */

interface HostQueue {
  /** Timestamp after which the next request to this host may start. */
  nextAllowedAt: number;
  /** Tail of the promise chain, serializing requests to this host. */
  chain: Promise<unknown>;
  minIntervalMs: number;
}

const hostQueues = new Map<string, HostQueue>();

function queueFor(host: string, minIntervalMs: number): HostQueue {
  let queue = hostQueues.get(host);
  if (!queue) {
    queue = { nextAllowedAt: 0, chain: Promise.resolve(), minIntervalMs };
    hostQueues.set(host, queue);
  }
  // A connector may ask for a slower rate than another sharing the host; the
  // most conservative request wins, since the limit belongs to the host.
  queue.minIntervalMs = Math.max(queue.minIntervalMs, minIntervalMs);
  return queue;
}

export interface HttpClientOptions {
  minRequestIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  log?: Logger;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

class RateLimitedHttpClient implements HttpClient {
  private readonly userAgent: string;
  private readonly minRequestIntervalMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly log: Logger | undefined;

  constructor(options: HttpClientOptions = {}) {
    this.userAgent = loadEnv().ELESSAR_USER_AGENT;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 1000;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.log = options.log;
  }

  async get(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const host = new URL(url).host;
    const queue = queueFor(host, this.minRequestIntervalMs);

    // Serialize on the host's chain so concurrent connectors sharing a host
    // (e.g. several GDELT endpoints) still respect one combined rate limit.
    const run = queue.chain.then(() => this.executeWithRetry(url, queue, options));
    // Keep the chain alive regardless of this request's outcome.
    queue.chain = run.catch(() => undefined);
    return run;
  }

  private async executeWithRetry(
    url: string,
    queue: HostQueue,
    options: HttpRequestOptions,
  ): Promise<HttpResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const waitMs = queue.nextAllowedAt - Date.now();
      if (waitMs > 0) await sleep(waitMs, options.signal);

      queue.nextAllowedAt = Date.now() + queue.minIntervalMs;

      try {
        const response = await this.execute(url, options);

        if (response.status < 400 || response.notModified) return response;

        if (!RETRYABLE_STATUS.has(response.status) || attempt === this.maxRetries) {
          throw new HttpError(url, response.status);
        }

        const retryAfterMs = parseRetryAfter(response.retryAfter);
        const delay = retryAfterMs ?? backoffMs(attempt);
        this.log?.warn(
          { url, status: response.status, attempt: attempt + 1, delayMs: delay },
          'retrying after error status',
        );
        queue.nextAllowedAt = Date.now() + delay;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (options.signal?.aborted) throw error;
        lastError = error;
        if (attempt === this.maxRetries) break;
        const delay = backoffMs(attempt);
        this.log?.warn(
          { url, attempt: attempt + 1, delayMs: delay, err: describe(error) },
          'retrying after transport error',
        );
        queue.nextAllowedAt = Date.now() + delay;
      }
    }

    throw new Error(`GET ${url} failed after ${this.maxRetries + 1} attempts: ${describe(lastError)}`);
  }

  private async execute(url: string, options: HttpRequestOptions): Promise<InternalResponse> {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: '*/*',
      'accept-encoding': 'gzip, deflate',
      ...options.headers,
    };
    if (options.etag) headers['if-none-match'] = options.etag;
    if (options.lastModified) headers['if-modified-since'] = options.lastModified;

    // Compose the caller's signal with our own timeout so neither is lost.
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;

    const res = await fetch(url, { headers, signal, redirect: 'follow' });

    return new InternalResponse(res);
  }
}

class InternalResponse implements HttpResponse {
  readonly status: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly notModified: boolean;
  readonly retryAfter: string | null;
  private readonly res: Response;

  constructor(res: Response) {
    this.res = res;
    this.status = res.status;
    this.etag = res.headers.get('etag');
    this.lastModified = res.headers.get('last-modified');
    this.retryAfter = res.headers.get('retry-after');
    this.notModified = res.status === 304;
  }

  async text(): Promise<string> {
    if (this.notModified) return '';
    return this.res.text();
  }

  async json<T = unknown>(): Promise<T> {
    if (this.notModified) throw new Error('Cannot read body of a 304 response');
    return this.res.json() as Promise<T>;
  }

  async bytes(): Promise<Uint8Array> {
    if (this.notModified) return new Uint8Array();
    return new Uint8Array(await this.res.arrayBuffer());
  }
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`GET ${url} → HTTP ${status}`);
    this.name = 'HttpError';
  }
}

/** Exponential backoff with full jitter, capped at 30s. */
function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 120_000);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.min(Math.max(0, date.getTime() - Date.now()), 120_000);
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  return new RateLimitedHttpClient(options);
}

/** Test-only: clear per-host rate limiter state. */
export function resetHttpState(): void {
  hostQueues.clear();
}
