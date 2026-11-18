import { monitorEventLoopDelay } from 'node:perf_hooks';

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const counters = {
  http_requests: 0,
  http_errors: 0,
  events_published: 0,
  events_consumed: 0,
  events_failed: 0,
};

export const metrics = {
  inc: (k) => (counters[k] = (counters[k] || 0) + 1),
  snapshot: () => {
    const m = process.memoryUsage();
    return {
      ...counters,
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(m.rss / 1e6),
      heap_used_mb: Math.round(m.heapUsed / 1e6),
      event_loop_p99_ms: Math.round(loop.percentile(99) / 1e6),
    };
  },
};
