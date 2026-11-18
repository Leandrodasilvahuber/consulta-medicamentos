// Bootstrap: libera leitura pública das landing pages e cria conteúdo inicial (demo).
const SEED = [
  {
    slug: 'consultas',
    title: 'Consulta online e sua receita sem sair de casa',
    subtitle: 'Fale com um médico por vídeo, receba a receita digital e compre seus medicamentos na nossa farmácia.',
    cta: 'Agendar consulta',
    steps: ['Agende e pague', 'Consulta por vídeo', 'Receita digital', 'Compre os medicamentos'],
  },
  {
    slug: 'vendas',
    title: 'Seus medicamentos com receita, entregues em casa',
    subtitle: 'Escolha o medicamento. Já tem receita? Finalize. Não tem? Consulte um médico online em minutos.',
    cta: 'Comprar com minha receita',
    steps: ['Escolha o medicamento', 'Informe a receita', 'Pague', 'Receba em casa com NF'],
  },
];

module.exports = {
  register() {},
  async bootstrap({ strapi }) {
    const role = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'public' } });
    for (const action of ['api::landing-page.landing-page.find', 'api::landing-page.landing-page.findOne']) {
      const exists = await strapi.db.query('plugin::users-permissions.permission').findOne({ where: { action, role: role.id } });
      if (!exists) await strapi.db.query('plugin::users-permissions.permission').create({ data: { action, role: role.id } });
    }
    for (const page of SEED) {
      const found = await strapi.documents('api::landing-page.landing-page').findFirst({ filters: { slug: page.slug } });
      if (!found) await strapi.documents('api::landing-page.landing-page').create({ data: page });
    }
  },
};
