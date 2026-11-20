import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { buildOpenApiDocument } from '../src/openapi/build-document';
import { setupSwagger } from '../src/openapi/swagger';
import { createApp } from './helpers';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function registeredRoutes(app: INestApplication): string[] {
  const stack = (app.getHttpAdapter().getInstance() as { _router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } })._router.stack;
  const out: string[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const m of METHODS) if (layer.route.methods[m]) out.push(`${m.toUpperCase()} ${layer.route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
  }
  return out.sort();
}

describe('OpenAPI document', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp({ beforeInit: setupSwagger });
  });
  afterAll(async () => {
    await app.close();
  });

  it('documents exactly the routes the application registers (no drift)', () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
    const documented = Object.entries(doc.paths)
      .flatMap(([p, ms]) => Object.keys(ms).map((m) => `${m.toUpperCase()} ${p}`))
      .sort();
    const registered = registeredRoutes(app).filter((r) => !/ \/api-docs/.test(r));
    expect(registered.filter((r) => !documented.includes(r))).toEqual([]);
    expect(documented.filter((r) => !registered.includes(r))).toEqual([]);
  });

  it('docs/openapi.json is up to date with the source (re-run `npm run openapi:export` after route changes)', () => {
    const exported = JSON.parse(readFileSync(join(__dirname, '..', '..', 'docs', 'openapi.json'), 'utf8'));
    expect(exported).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it('every operation has a summary, a response and declared security (or is explicitly public)', () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, any>>; components: { securitySchemes: Record<string, unknown> } };
    for (const [p, ms] of Object.entries(doc.paths)) {
      for (const [m, o] of Object.entries(ms)) {
        expect([p, m, typeof o.summary]).toEqual([p, m, 'string']);
        expect(Object.keys(o.responses).length).toBeGreaterThan(0);
        for (const req of o.security as Record<string, unknown>[]) for (const s of Object.keys(req)) expect(doc.components.securitySchemes[s]).toBeDefined();
        for (const name of (p.match(/\{(\w+)\}/g) ?? []).map((x) => x.slice(1, -1))) {
          expect((o.parameters ?? []).some((q: any) => q.in === 'path' && q.name === name)).toBe(true);
        }
      }
    }
  });

  it('serves Swagger UI and the JSON spec without auth', async () => {
    const http = request(app.getHttpServer());
    const ui = await http.get('/api-docs');
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('swagger-ui');
    const json = await http.get('/api-docs-json');
    expect(json.status).toBe(200);
    expect(json.body.openapi).toBe('3.0.3');
    expect(Object.keys(json.body.paths).length).toBeGreaterThan(50);
  });
});
