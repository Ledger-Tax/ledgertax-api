import { Readable } from 'node:stream';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import {
  AccountNotFoundError,
  HorizonHttpError,
  HorizonResponseError,
  InvalidAddressError,
  MalformedRecordError,
  SecretKeyInputError,
  StreamInterruptedError,
  isLikelySecretKey,
  parseStellarAddress,
} from '@veronicdev/ledgertax-core';
import type { HistorySource } from '@veronicdev/ledgertax-core';
import { z } from 'zod';
import { UnsupportedMethodError } from './costbasis.js';
import { HistoryTooLargeError, PriceCsvError, PriceCsvTooLargeError } from './errors.js';
import { buildReport, streamEvents, toEventDto } from './service.js';
import type { ServiceDeps, SourceInfo } from './service.js';

/** Everything {@link createApp} needs. */
export interface AppOptions {
  source: HistorySource;
  /** Says which source and range reports use. */
  describeSource: () => Promise<SourceInfo>;
  maxBodyBytes: number;
  maxPriceCsvBytes: number;
  maxEvents: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  corsOrigins: readonly string[];
  trustProxy: boolean;
  /** Clock, replaced in tests. */
  now?: () => Date;
  /**
   * Request logging. Off by default. When on, only the method, the path WITHOUT its query string,
   * the status and the timing are logged: never an address, a body or a header.
   */
  logStream?: NodeJS.WritableStream;
}

/** Shape of every error response. */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; cursor?: string };
}

interface HttpError {
  status: number;
  body: ErrorBody;
}

const labelSchema = z.object({
  eventId: z.string().min(1).max(300),
  label: z.enum(['income', 'disposal', 'transfer', 'gift', 'ignore']),
  note: z.string().max(500).optional(),
});

/** True for a real calendar date (no 30 February), optionally with a UTC time. */
function isRealDateTime(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m || Number.isNaN(Date.parse(text))) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const sinceSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/, 'Use YYYY-MM-DD or a UTC ISO time')
  .refine(isRealDateTime, 'Not a real date')
  .transform((s) => (s.length === 10 ? `${s}T00:00:00Z` : s));

const eventsQuerySchema = z.strictObject({
  address: z.string().min(1).max(300),
  since: sinceSchema.optional(),
  format: z.enum(['json', 'ndjson']).default('json'),
});

const reportBodySchema = z.strictObject({
  address: z.string().min(1).max(300),
  since: sinceSchema.optional(),
  method: z.literal('fifo').default('fifo'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Three capital letters, for example USD'),
  fiatDecimals: z.number().int().min(0).max(8).default(2),
  priceCsv: z.string().optional(),
  labels: z.array(labelSchema).max(50_000).default([]),
});

/** Looks for anything shaped like a secret key in a request, without ever returning or logging it. */
function containsSecret(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === 'string') {
    if (isLikelySecretKey(value)) return true;
    if (value.length < 56) return false;
    return value
      .split(/[\s,;"']+/)
      .some((token) => token.length === 56 && isLikelySecretKey(token));
  }
  if (Array.isArray(value)) return value.some((v) => containsSecret(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value).some((v) => containsSecret(v, depth + 1));
  }
  return false;
}

function mapError(error: unknown): HttpError {
  const fail = (
    status: number,
    code: string,
    message: string,
    extra: Partial<ErrorBody['error']> = {},
  ): HttpError => ({
    status,
    body: { error: { code, message, ...extra } },
  });
  if (error instanceof SecretKeyInputError) return fail(400, 'secret_key_rejected', error.message);
  if (error instanceof InvalidAddressError) return fail(400, 'invalid_address', error.message);
  if (error instanceof AccountNotFoundError) return fail(404, 'account_not_found', error.message);
  if (error instanceof PriceCsvError) {
    return fail(422, 'invalid_price_csv', error.message, { details: error.issues.slice(0, 100) });
  }
  if (error instanceof PriceCsvTooLargeError)
    return fail(413, 'price_csv_too_large', error.message);
  if (error instanceof HistoryTooLargeError) return fail(422, 'history_too_large', error.message);
  if (error instanceof UnsupportedMethodError)
    return fail(400, 'unsupported_method', error.message);
  if (error instanceof StreamInterruptedError && error.cause instanceof AccountNotFoundError) {
    return fail(404, 'account_not_found', error.cause.message);
  }
  if (error instanceof StreamInterruptedError) {
    return fail(
      502,
      'upstream_failed',
      error.message,
      error.cursor ? { cursor: error.cursor } : {},
    );
  }
  if (error instanceof HorizonHttpError || error instanceof HorizonResponseError) {
    return fail(502, 'upstream_failed', error.message);
  }
  if (error instanceof MalformedRecordError) return fail(502, 'upstream_malformed', error.message);
  if (error instanceof z.ZodError) {
    return fail(400, 'invalid_request', 'The request is not valid.', {
      details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const status = (error as { statusCode?: number }).statusCode;
  if (status === 413) return fail(413, 'payload_too_large', 'The request body is too large.');
  if (status === 415)
    return fail(415, 'unsupported_media_type', 'Send the body as application/json.');
  if (status === 400) return fail(400, 'invalid_json', 'The request body is not valid JSON.');
  return fail(500, 'internal_error', 'Something went wrong on the server.');
}

/**
 * Builds the HTTP API: `GET /health`, `GET /events`, `POST /reports`.
 *
 * Design for long histories: `GET /events?format=ndjson` streams one JSON line per event as they are
 * classified, ending with a `done` or `error` line (progress for the client); `POST /reports` is
 * synchronous and bounded by `maxEvents` and the body limit. Larger histories are refused with
 * `history_too_large` and the client is told to narrow the range with `since`.
 *
 * Privacy: labels and prices travel in the request and are never stored; only public chain history
 * may be cached. Secret-key-shaped input is rejected before anything is processed.
 */
export function createApp(options: AppOptions): FastifyInstance {
  const serverOptions: FastifyServerOptions = {
    bodyLimit: options.maxBodyBytes,
    trustProxy: options.trustProxy,
    logger: options.logStream
      ? {
          level: 'info',
          stream: options.logStream,
          serializers: {
            req: (req: { method?: string; url?: string }) => ({
              method: req.method,
              path: req.url?.split('?')[0],
            }),
            res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
          },
        }
      : false,
  };
  const app: FastifyInstance = Fastify(serverOptions);
  const deps: ServiceDeps = {
    source: options.source,
    describeSource: options.describeSource,
    maxEvents: options.maxEvents,
    maxPriceCsvBytes: options.maxPriceCsvBytes,
    now: options.now ?? (() => new Date()),
  };

  // ---- CORS (off unless origins are configured) ----
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && options.corsOrigins.includes(origin)) {
      reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
      if (req.method === 'OPTIONS') {
        return reply
          .header('access-control-allow-methods', 'GET, POST, OPTIONS')
          .header('access-control-allow-headers', 'content-type')
          .header('access-control-max-age', '600')
          .code(204)
          .send();
      }
    }
    return undefined;
  });

  // ---- rate limit per IP (in memory, keeps no addresses or request contents) ----
  const hits = new Map<string, number[]>();
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health' || req.method === 'OPTIONS') return undefined;
    const now = Date.now();
    const recent = (hits.get(req.ip) ?? []).filter((t) => now - t < options.rateLimitWindowMs);
    if (recent.length >= options.rateLimitMax) {
      const retryAfter = Math.max(
        1,
        Math.ceil(((recent[0] ?? now) + options.rateLimitWindowMs - now) / 1000),
      );
      return reply
        .header('retry-after', String(retryAfter))
        .code(429)
        .send({
          error: { code: 'rate_limited', message: 'Too many requests. Try again later.' },
        } satisfies ErrorBody);
    }
    recent.push(now);
    hits.set(req.ip, recent);
    if (hits.size > 10_000) {
      for (const [ip, times] of hits)
        if (times.every((t) => now - t >= options.rateLimitWindowMs)) hits.delete(ip);
    }
    return undefined;
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('cache-control', 'no-store');
  });

  // ---- never accept a secret key, anywhere in the query or body ----
  app.addHook('preHandler', async (req, reply) => {
    if (containsSecret(req.query) || containsSecret(req.body)) {
      const e = mapError(new SecretKeyInputError());
      return reply.code(e.status).send(e.body);
    }
    return undefined;
  });

  app.setErrorHandler((error, _req, reply) => {
    const mapped = mapError(error);
    if (mapped.status >= 500) app.log.error({ code: mapped.body.error.code }, 'request failed');
    return reply.code(mapped.status).send(mapped.body);
  });
  app.setNotFoundHandler((_req, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'not_found', message: 'No such route.' } } satisfies ErrorBody),
  );

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/events', async (req, reply) => {
    const q = eventsQuerySchema.parse(req.query);
    const parsed = parseStellarAddress(q.address);
    if (!parsed.ok) throw parsed.error;
    const address = parsed.value.address;
    const info = await options.describeSource();
    const events = streamEvents(options.source, address, {
      since: q.since,
      maxEvents: options.maxEvents,
    });

    if (q.format === 'ndjson') {
      // Pull the first item before answering, so a bad account or a source failure is a normal HTTP error.
      const first = await events.next();
      async function* lines(): AsyncGenerator<string> {
        let count = 0;
        try {
          let step = first;
          while (!step.done) {
            count += 1;
            yield `${JSON.stringify({ event: toEventDto(step.value) })}\n`;
            step = await events.next();
          }
          yield `${JSON.stringify({ done: true, count })}\n`;
        } catch (error) {
          yield `${JSON.stringify(mapError(error).body)}\n`;
        }
      }
      return reply.type('application/x-ndjson; charset=utf-8').send(Readable.from(lines()));
    }

    const out = [];
    for await (const e of events) out.push(toEventDto(e));
    return { address, source: info, count: out.length, events: out };
  });

  app.post('/reports', async (req) => {
    const body = reportBodySchema.parse(req.body);
    return buildReport(deps, body);
  });

  return app;
}
