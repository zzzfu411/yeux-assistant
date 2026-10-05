import { z } from 'zod';
import type { Application } from '../../../../packages/core/src/application.js';
import { SourceInput, SourceUpdateInput, SourceArchiveInput } from '../../../../packages/contracts/src/index.js';
import { originalAsset } from '../../../../packages/core/src/course-import.js';
import { type ApiServer, key, params } from './shared.js';
export function registerSourceRoutes(server: ApiServer, app: Application, folder: string) {
    server.get('/sources', { schema: { querystring: z.object({ archived: z.enum(['true', 'false']).default('false') }).strict() } }, r => app.sources(r.query.archived === 'true'));
    server.get('/sources/:id', { schema: { params, querystring: z.object({ version: z.coerce.number().int().positive().optional() }) } }, r => app.source(r.params.id, r.query.version));
    server.get('/sources/:id/original', { schema: { params, querystring: z.object({ version: z.coerce.number().int().positive().optional() }) } }, async (r, p) => {
        const detail = await app.source(r.params.id, r.query.version);
        const asset = await originalAsset(folder, detail.metadata);
        const filename = encodeURIComponent(asset.filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
        p.type('application/octet-stream').header('Content-Disposition', `attachment; filename="source"; filename*=UTF-8''${filename}`);
        return asset.bytes;
    });
    server.post('/sources', { schema: { body: SourceInput } }, r => app.importSource(key(r), r.body));
    server.patch('/sources/:id', { schema: { params, body: SourceUpdateInput } }, r => app.updateSource(key(r), r.params.id, r.body));
    server.patch('/sources/:id/archive', { schema: { params, body: SourceArchiveInput } }, r => app.archiveSource(key(r), r.params.id, r.body));
    server.get('/search', { schema: { querystring: z.object({ q: z.string().trim().min(1).max(2000), course: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/).optional() }) } }, r => app.search(r.query.q, r.query.course));
}
