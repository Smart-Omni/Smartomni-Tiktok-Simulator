import { info, schemas, securitySchemes } from './components';
import { paths as demo } from './demo.paths';
import { Json, PathsFragment } from './helpers';
import { paths as system } from './system.paths';
import { paths as testAdmin } from './test-admin.paths';
import { paths as tiktokA } from './tiktok-a.paths';
import { paths as tiktokB } from './tiktok-b.paths';
import { paths as simulator } from './simulator.paths';

/** Assembles the OpenAPI 3.0 document. Pure function: no app, DB or env needed (used by Swagger UI, the export script and the drift test). */
export function buildOpenApiDocument(serverUrl = 'http://localhost:8090'): Json {
  const paths: PathsFragment = {};
  for (const fragment of [system, tiktokA, tiktokB, demo, testAdmin, simulator]) {
    for (const [p, methods] of Object.entries(fragment)) {
      if (paths[p]) {
        for (const m of Object.keys(methods)) if (paths[p][m]) throw new Error(`duplicate OpenAPI operation ${m.toUpperCase()} ${p}`);
      }
      paths[p] = { ...(paths[p] ?? {}), ...methods };
    }
  }
  return {
    openapi: '3.0.3',
    info,
    servers: [{ url: serverUrl, description: 'Local simulator API (Docker default)' }],
    paths,
    components: { securitySchemes, schemas },
  };
}
