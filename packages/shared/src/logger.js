import { currentTrace } from './context.js';

const service = process.env.SERVICE || 'unknown';
const write = (level, msg, extra = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service,
      traceId: currentTrace().traceId,
      msg,
      ...extra,
    }),
  );

export const log = {
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};
