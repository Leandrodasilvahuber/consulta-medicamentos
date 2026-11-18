import http from 'node:http';

/** Cliente mínimo da Docker Engine API via socket unix (sem dependências). */
const PROJECT = process.env.COMPOSE_PROJECT || 'consulta-medicamentos';

function call(method, path, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: '/var/run/docker.sock', method, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) return reject(new Error(`docker ${res.statusCode}: ${buf.toString()}`));
        if (raw) return resolve(buf);
        resolve(buf.length ? JSON.parse(buf.toString()) : null);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Logs do docker vêm multiplexados: header de 8 bytes (stream, 0,0,0, tamanho BE) + payload. */
function demux(buf) {
  const lines = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    lines.push(buf.subarray(i + 8, i + 8 + size).toString());
    i += 8 + size;
  }
  return lines.join('').split('\n').filter(Boolean);
}

export async function containers() {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${PROJECT}`] }));
  const list = await call('GET', `/containers/json?all=true&filters=${filters}`);
  return list.map((c) => ({
    id: c.Id.slice(0, 12),
    name: c.Names[0].replace(/^\//, ''),
    service: c.Labels['com.docker.compose.service'],
    state: c.State,
    status: c.Status,
  }));
}

export async function stats(id) {
  const s = await call('GET', `/containers/${id}/stats?stream=false`);
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage || 0);
  const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage || 0);
  const cpus = s.cpu_stats.online_cpus || 1;
  const cache = s.memory_stats.stats?.inactive_file || 0;
  return {
    memMb: Math.round(((s.memory_stats.usage || 0) - cache) / 1e6),
    memLimitMb: Math.round((s.memory_stats.limit || 0) / 1e6),
    cpuPct: sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10 : 0,
    pids: s.pids_stats?.current,
  };
}

export const logs = async (id, tail = 200) =>
  demux(await call('GET', `/containers/${id}/logs?stdout=true&stderr=true&tail=${tail}`, { raw: true }));

export const action = (id, verb) => call('POST', `/containers/${id}/${verb}`); // kill | restart | pause | unpause | stop | start
