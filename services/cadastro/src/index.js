import { randomUUID } from 'node:crypto';
import { serve, repo, publish, HttpError, filterBy, notFound } from '@cm/shared';

const db = repo('cm-cadastro');
const KINDS = { customers: 'Customer', employees: 'Employee', suppliers: 'Supplier' };
const REQUIRED = {
  customers: ['name', 'document', 'email'],
  employees: ['name', 'role'],
  suppliers: ['name', 'cnpj'],
};

const routes = {};
for (const [path, type] of Object.entries(KINDS)) {
  routes[`POST /${path}`] = async ({ body }) => {
    const missing = REQUIRED[path].filter((f) => !body[f]);
    if (missing.length) throw new HttpError(422, `campos obrigatórios: ${missing.join(', ')}`);
    const item = await db.put({ pk: randomUUID(), type, ...body, createdAt: new Date().toISOString() });
    await publish(`${type}Registered`, { id: item.pk, name: item.name });
    return { id: item.pk, ...item };
  };
  routes[`GET /${path}`] = async ({ query }) => filterBy(await db.list(type), query);
  routes[`GET /${path}/:id`] = async ({ params }) => notFound(await db.get(params.id));
}
serve(routes);
