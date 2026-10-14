import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { DeviceBridges, type BridgePrincipal } from '../../../../packages/core/src/devices/bridge.js';
import { AppError } from '../../../../packages/core/src/common.js';
import {
  BridgeLease,
  BridgeEvidence,
  BridgePoll,
  BridgeReport,
  CreateDeviceBridge,
} from '../../../../packages/contracts/src/device-bridge.js';
import { type ApiServer, key, params } from './shared.js';

export function registerDeviceBridgeManagement(
  api: ApiServer,
  bridges: DeviceBridges,
  administrator: (request: FastifyRequest) => Promise<boolean>,
) {
  const owner = async (request: FastifyRequest) => {
    if (!(await administrator(request)))
      throw new AppError('请通过管理员登录管理设备连接。', 403, 'administrator_required');
  };
  api.get(
    '/device-commands/:id/evidence/:digest',
    { schema: { params: z.object({ id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }) } },
    async (r, reply) =>
      reply
        .type('image/png')
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(await bridges.readEvidence(r.params.id, r.params.digest)),
  );
  api.post('/devices/bridges', { onRequest: owner, schema: { body: CreateDeviceBridge } }, (r) =>
    bridges.issue(key(r), r.body),
  );
  api.post('/devices/:id/revoke-bridge', { onRequest: owner, schema: { params } }, (r) =>
    bridges.revoke(key(r), r.params.id),
  );
}
export async function registerDeviceBridgeRoutes(server: ApiServer, bridges: DeviceBridges) {
  await server.register(
    async (scope) => {
      const api = scope.withTypeProvider<ZodTypeProvider>();
      const actors = new WeakMap<FastifyRequest, BridgePrincipal>();
      api.addHook('onRequest', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        actors.set(request, await bridges.authenticate(request.headers.authorization));
      });
      api.post('/poll', { bodyLimit: 1024, schema: { body: BridgePoll } }, (r) => bridges.poll(actors.get(r)!, r.body));
      api.post('/calls/:id/start', { bodyLimit: 1024, schema: { params, body: BridgeLease } }, (r) =>
        bridges.start(actors.get(r)!, r.params.id, r.body.lease),
      );
      api.post('/calls/:id/evidence', { bodyLimit: 2_800_000, schema: { params, body: BridgeEvidence } }, (r) =>
        bridges.evidence(actors.get(r)!, r.params.id, r.body),
      );
      api.post('/calls/:id/result', { bodyLimit: 16384, schema: { params, body: BridgeReport } }, (r) =>
        bridges.report(actors.get(r)!, r.params.id, r.body),
      );
    },
    { prefix: '/api/device/v1' },
  );
}
