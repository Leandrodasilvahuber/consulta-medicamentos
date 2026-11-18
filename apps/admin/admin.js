/* global esc, toast */
/* helpers comuns das áreas administrativas */
const PAGES = [
  ['index.html', 'Início'],
  ['medico.html', 'Médico'],
  ['paciente.html', 'Paciente'],
  ['estoque.html', 'Estoque'],
  ['expedicao.html', 'Expedição'],
  ['ops.html', 'Operações'],
  ['caos.html', 'Lab. de Caos'],
];
window.nav = function () {
  document.head.insertAdjacentHTML(
    'beforeend',
    '<link rel="icon" href="/admin/favicon.svg" type="image/svg+xml" />' +
      '<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&family=Inter:wght@400;600;700&display=swap" rel="stylesheet" />',
  );
  const cur = location.pathname.split('/').pop() || 'index.html';
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<nav><a class="brand" href="/admin/"><img src="/admin/favicon.svg" alt="" />Vitalis · Backoffice</a>' +
      PAGES.map(([h, t]) => `<a href="/admin/${h}" class="${h === cur ? 'on' : ''}">${t}</a>`).join('') +
      '<a href="/" style="margin-left:auto">Landing consultas</a><a href="/loja/">Loja</a></nav>',
  );
};
window.api = async function (path, body, key) {
  const opts = body
    ? {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key || crypto.randomUUID() },
        body: JSON.stringify(body),
      }
    : {};
  const r = await fetch('/api' + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
};
window.esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
window.fmtDate = (s) => (s ? new Date(s).toLocaleString('pt-BR') : '');
window.money = (v) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const TONE = {
  CONFIRMED: 'ok',
  COMPLETED: 'ok',
  DELIVERED: 'ok',
  APPROVED: 'ok',
  PAID: 'ok',
  running: 'ok',
  up: 'ok',
  AWAITING_PAYMENT: 'warn',
  AWAITING_STOCK: 'warn',
  READY_TO_SHIP: 'warn',
  SCHEDULED: 'info',
  paused: 'warn',
  INVOICED: 'info',
  SHIPPED: 'info',
  DISPATCHED: 'info',
  CANCELLED: 'err',
  DECLINED: 'err',
  PAYMENT_DECLINED: 'err',
  exited: 'err',
  error: 'err',
  warn: 'warn',
  info: 'info',
};
window.badge = (s) => `<span class="badge ${TONE[s] || ''}">${esc(s)}</span>`;
window.table = function (rows, cols, empty = 'Nada por aqui.') {
  if (!rows?.length) return `<p class="muted">${empty}</p>`;
  return (
    '<table><thead><tr>' +
    cols.map((c) => `<th>${c[0]}</th>`).join('') +
    '</tr></thead><tbody>' +
    rows
      .map((r) => '<tr>' + cols.map((c) => `<td class="${c[2] || ''}">${c[1](r)}</td>`).join('') + '</tr>')
      .join('') +
    '</tbody></table>'
  );
};
window.toast = function (msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast';
  if (isErr) el.style.background = '#b3123a';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
};
window.act = async function (fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast('Erro: ' + e.message, true);
  }
};
window.every = function (ms, fn) {
  fn();
  return setInterval(fn, ms);
};
window.$ = (s) => document.querySelector(s);
