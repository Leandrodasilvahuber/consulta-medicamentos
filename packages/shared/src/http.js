import http from 'node:http';
import { withIdempotency } from './idempotency.js';
import { runWithTrace, currentTrace } from './context.js';
import { injectFault } from './chaos.js';
import { metrics } from './metrics.js';
import { log } from './logger.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Filtra uma lista pelos parâmetros da query string (?customerId=..&status=..). */
export const filterBy = (items, query = {}) =>
  items.filter((i) => Object.entries(query).every(([k, v]) => String(i[k]) === v));

export const notFound = (v) => v || Promise.reject(new HttpError(404, 'not found'));

const MAX_BODY = 1024 * 1024;

function compile(routes) {
  return Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '/?$');
    return { method, re, names, handler };
  });
}

function match(compiled, method, url) {
  const path = url.split('?')[0];
  for (const r of compiled) {
    if (r.method !== method) continue;
    const found = path.match(r.re);
    if (found)
      return {
        handler: r.handler,
        params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(found[i + 1])])),
      };
  }
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new HttpError(413, 'payload muito grande');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

/** Servidor HTTP mínimo: rotas, /health, /metrics, Idempotency-Key obrigatória em POST, graceful shutdown. */
export function serve(routes, { port = Number(process.env.PORT) || 3000, onShutdown } = {}) {
  const service = process.env.SERVICE;
  const compiled = compile(routes);
  let ready = true;
  const server = http.createServer((req, res) =>
    runWithTrace({ traceId: req.headers['x-trace-id'] }, () => handle(req, res)),
  );
  async function handle(req, res) {
    metrics.inc('http_requests');
    const send = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'x-trace-id',
        'x-trace-id': currentTrace().traceId,
      });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type,idempotency-key,x-trace-id',
        'access-control-allow-methods': 'GET,POST',
      });
      return res.end();
    }
    if (req.url === '/health') return send(ready ? 200 : 503, { service, status: ready ? 'up' : 'draining' });
    if (req.url === '/metrics') return send(200, { service, ...metrics.snapshot() });

    const query = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const route = match(compiled, req.method, req.url);
    if (!route) return send(404, { error: 'not found' });
    try {
      await injectFault('http');
      const body = await readJson(req);
      const exec = async () => {
        const out = await route.handler({ body, params: route.params, query });
        // handler pode devolver { $status, body } para escolher o código HTTP
        if (out?.$status) return { status: out.$status, body: out.body };
        return { status: req.method === 'POST' ? 201 : 200, body: out };
      };
      let result;
      if (req.method === 'POST') {
        const key = req.headers['idempotency-key'];
        if (!key) throw new HttpError(400, 'Idempotency-Key header required');
        result = await withIdempotency(`http#${service}#${req.url}#${key}`, exec);
      } else result = await exec();
      res.setHeader('idempotent-replayed', String(!!result.replayed));
      send(result.status, result.body);
    } catch (err) {
      metrics.inc('http_errors');
      if (!err.status) log.error('http.error', { err: err.message });
      send(err.status || 500, { error: err.message });
    }
  }
  server.listen(port, () => log.info('http.listening', { port }));

  const shutdown = async () => {
    ready = false; // health 503 -> LB tira a réplica
    log.info('shutdown.start');
    await onShutdown?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}
