import { log } from '@cm/shared';

/** Integração com a API do Zabbix: provisiona hosts/itens/triggers e lê problemas ativos. */
const URL = process.env.ZABBIX_API || 'http://zabbix-web:8080/api_jsonrpc.php';
let token;

async function rpc(method, params) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json-rpc',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.data || j.error.message}`);
  return j.result;
}

const login = async () => (token = await rpc('user.login', { username: 'Admin', password: 'zabbix' }));

const MONITORED = [
  'cadastro',
  'agendamento',
  'consulta',
  'receita',
  'venda',
  'pedido',
  'pagamento',
  'estoque',
  'entrega',
  'nf-worker',
];

export async function provision() {
  await login();
  let [group] = await rpc('hostgroup.get', { filter: { name: ['consulta-medicamentos'] } });
  if (!group)
    group = { groupid: (await rpc('hostgroup.create', { name: 'consulta-medicamentos' })).groupids[0] };
  const hosts = [
    ...MONITORED.map((s) => ({ s, url: `http://${s}:3000` })),
    { s: 'admin', url: 'http://admin:3000' },
  ];
  for (const { s, url } of hosts) {
    if ((await rpc('host.get', { filter: { host: [`cm-${s}`] } })).length) continue;
    const hostid = (await rpc('host.create', { host: `cm-${s}`, groups: [{ groupid: group.groupid }] }))
      .hostids[0];
    await rpc('item.create', {
      name: `health ${s}`,
      key_: `health.${s}`,
      hostid,
      type: 19,
      value_type: 4,
      delay: '30s',
      url: `${url}/health`,
    });
    await rpc('trigger.create', {
      description: `${s} fora do ar`,
      priority: 4,
      expression: `find(/cm-${s}/health.${s},,"like","up")=0 or nodata(/cm-${s}/health.${s},2m)=1`,
    });
    if (s === 'admin') {
      await rpc('item.create', {
        name: 'mensagens em DLQ',
        key_: 'dlq.total',
        hostid,
        type: 19,
        value_type: 3,
        delay: '30s',
        url: `${url}/dlq-total`,
      });
      await rpc('trigger.create', {
        description: 'Há mensagens na DLQ',
        priority: 3,
        expression: 'last(/cm-admin/dlq.total)>0',
      });
    }
  }
  // host padrão "Zabbix server" aponta o agente para o container zabbix-agent
  const [srv] = await rpc('host.get', {
    filter: { host: ['Zabbix server'] },
    selectInterfaces: ['interfaceid'],
  });
  if (srv?.interfaces?.[0])
    await rpc('hostinterface.update', {
      interfaceid: srv.interfaces[0].interfaceid,
      useip: 0,
      dns: 'zabbix-agent',
    });
  log.info('zabbix.provisioned');
}

export async function problems() {
  if (!token) await login();
  const list = await rpc('problem.get', {
    output: 'extend',
    recent: false,
    sortfield: ['eventid'],
    sortorder: 'DESC',
  });
  return list.map((p) => ({
    name: p.name,
    severity: Number(p.severity),
    since: new Date(p.clock * 1000).toISOString(),
  }));
}

// provisiona assim que o Zabbix estiver de pé (retry)
export function provisionInBackground() {
  const attempt = () =>
    provision().catch((err) => {
      log.warn('zabbix.provision.retry', { err: err.message });
      setTimeout(attempt, 15000).unref();
    });
  attempt();
}
