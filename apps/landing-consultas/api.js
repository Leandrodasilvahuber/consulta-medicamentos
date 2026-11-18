/* helper compartilhado pelas landings: chama a API via gateway com Idempotency-Key */
window.api = async function (path, body) {
  const opts = body
    ? {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify(body),
      }
    : {};
  const r = await fetch('/api' + path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.status);
  return data;
};
window.poll = async function (fn, ok, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (ok(v)) return v;
    } catch (_e) {
      /* ainda não existe */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('timeout aguardando evento');
};
window.loadCms = async function (slug) {
  try {
    const r = await fetch(`/cms/api/landing-pages?filters[slug][$eq]=${slug}`);
    const page = (await r.json()).data[0];
    if (!page) return;
    const safe = page.title.replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );
    document.querySelector('h1').innerHTML = safe.replace(
      /(medicamentos?|cl[ií]nic[oa] geral|receita)/i,
      '<em>$1</em>',
    );
    document.querySelector('.hero .lead').textContent = page.subtitle;
    document.querySelector('.steps').innerHTML = page.steps.map((s) => `<li>${s}</li>`).join('');
  } catch (_e) {
    /* Strapi fora do ar: usa conteúdo estático (fallback) */
  }
};
window.out = (msg) => {
  const li = document.createElement('li');
  if (/^erro/i.test(msg)) li.className = 'err';
  li.textContent = msg;
  document.getElementById('log').appendChild(li);
};
