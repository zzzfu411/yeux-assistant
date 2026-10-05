import type { Application } from '../../../../packages/core/src/application.js';
import type { Store } from '../../../../packages/storage/src/index.js';
import { MemoryInput, ScheduleInput } from '../../../../packages/contracts/src/index.js';
import { type ApiServer, key, params, pageQuery } from './shared.js';
export function registerOrganizationRoutes(server: ApiServer, app: Application, store: Store) {
    server.get('/memories', async () => app.memories());
    server.get('/memories/:id/history', { schema: { params } }, r => store.rows('SELECT * FROM app.memory_versions WHERE key=$1 ORDER BY version DESC LIMIT 100', [r.params.id]));
    server.post('/memories', { schema: { body: MemoryInput } }, r => app.saveMemory(key(r), r.body));
    server.get('/schedules', async () => app.schedules());
    server.post('/schedules', { schema: { body: ScheduleInput } }, r => app.saveSchedule(key(r), undefined, r.body));
    server.patch('/schedules/:id', { schema: { params, body: ScheduleInput } }, r => app.saveSchedule(key(r), r.params.id, r.body));
    server.get('/notifications', { schema: { querystring: pageQuery } }, r => app.notifications(r.query.page));
    server.post('/notifications/:id/read', { schema: { params } }, r => app.readNotification(key(r), r.params.id));
}
