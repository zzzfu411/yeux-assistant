import type { Application } from '../../../../packages/core/src/application.js';
import type { MailActions } from '../../../../packages/core/src/mail.js';
import { config } from '../../../../packages/core/src/config.js';
import { AppError } from '../../../../packages/core/src/common.js';
import { modelEndpoint, readModelResponse } from '../../../../packages/core/src/model-http.js';
import { ModelSettingsInput, ApprovalDecision, ApprovalResolution } from '../../../../packages/contracts/src/index.js';
import { type ApiServer, key, params, revisionBody } from './shared.js';
export function registerIntegrationRoutes(server: ApiServer, app: Application, mail: MailActions, folder: string) {
    server.get('/settings/model', async () => app.settings.get());
    server.patch('/settings/model', { schema: { body: ModelSettingsInput } }, r => app.saveSettings(key(r), r.body));
    server.post('/settings/model/test', async () => {
        const current = (await config(folder)).llm;
        if (!current?.base_url || !current?.model)
            throw new AppError('请先保存模型地址与名称。');
        try {
            const response = await fetch(modelEndpoint(current.base_url), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(current.api_key ? { Authorization: 'Bearer ' + current.api_key } : {}) }, body: JSON.stringify({ model: current.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 }), signal: AbortSignal.timeout(15000), redirect: 'error' });
            if (!response.ok) {
                await response.body?.cancel();
                throw new AppError('模型连接失败（HTTP ' + response.status + '），请检查地址、名称和密钥。', 502, 'provider_error');
            }
            await readModelResponse(response);
            return { ok: true, message: '连接成功。' };
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            throw new AppError('连接模型超时或网络不可用，请检查设置。', 502, 'provider_error');
        }
    });
    server.post('/sessions/:id/approval', { schema: { params, body: revisionBody } }, r => mail.request(key(r), r.params.id, r.body));
    server.post('/approvals/:id/decision', { schema: { params, body: ApprovalDecision } }, r => mail.decide(key(r), r.params.id, r.body));
    server.post('/approvals/:id/resolve', { schema: { params, body: ApprovalResolution } }, r => mail.resolve(key(r), r.params.id, r.body));
}
