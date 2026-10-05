import Fastify, { type FastifyRequest } from 'fastify';
import staticFiles from '@fastify/static';
import { validatorCompiler, serializerCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from '../../../packages/storage/src/index.js';
import { Application } from '../../../packages/core/src/application.js';
import { DeviceActions } from '../../../packages/core/src/devices/service.js';
import { MailActions } from '../../../packages/core/src/mail.js';
import { createBoss } from '../../../packages/core/src/queue.js';
import { dataFolder, initializeData } from '../../../packages/core/src/config.js';
import { Authentication, sessionCookie, cookieHeader } from '../../../packages/core/src/auth.js';
import { AppError } from '../../../packages/core/src/common.js';
import { LoginInput } from '../../../packages/contracts/src/index.js';
import { publicOrigin, checkOrigin, secureSession } from './http-policy.js';
import { registerLearningRoutes } from './routes/learning.js';
import { registerSourceRoutes } from './routes/sources.js';
import { registerOrganizationRoutes } from './routes/organization.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerEventRoutes } from './routes/events.js';
import { registerStatusRoutes } from './routes/status.js';
import { DeviceBridges } from '../../../packages/core/src/devices/bridge.js';
import { registerDeviceBridgeManagement, registerDeviceBridgeRoutes } from './routes/device-bridge.js';
import { AgentAccess } from '../../../packages/core/src/agents.js';
import { registerAgentManagement, registerAgentRoutes } from './routes/agents.js';

export async function buildServer(
  options: { url?: string; folder?: string; assets?: boolean; publicOrigin?: string } = {},
) {
  const externalOrigin = publicOrigin(options.publicOrigin ?? process.env.ASSISTANT_PUBLIC_ORIGIN);
  const folder = options.folder || dataFolder();
  const token = await initializeData(folder);
  const store = new Store(options.url);
  let boss: Awaited<ReturnType<typeof createBoss>> | undefined;
  let closing = false;
  const server = Fastify({
    logger: false,
    bodyLimit: 2_100_000,
    requestTimeout: 20000,
    connectionTimeout: 20000,
    keepAliveTimeout: 10000,
  }).withTypeProvider<ZodTypeProvider>();
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  server.addHook('preClose', async () => {
    closing = true;
  });
  server.addHook('onClose', async () => {
    const results = await Promise.allSettled([boss?.stop(), store.close()]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  });
  server.addHook('onRequest', async (request) => {
    checkOrigin(request, externalOrigin);
  });
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    return payload;
  });
  server.setErrorHandler((error, _request, reply) => {
    const err = error as {
      code?: string;
      cause?: { code?: string };
      validation?: unknown;
      statusCode?: number;
      message?: string;
    };
    const invalid = error instanceof ZodError || err.validation;
    const conflict = (err.code || err.cause?.code) === '23505';
    const status =
      error instanceof AppError
        ? error.status
        : invalid
          ? 400
          : conflict
            ? 409
            : err.statusCode && err.statusCode < 500
              ? err.statusCode
              : 500;
    reply.code(status).send({
      error: {
        code:
          error instanceof AppError
            ? error.code
            : invalid
              ? 'invalid_request'
              : conflict
                ? 'conflict'
                : 'internal_error',
        message:
          error instanceof AppError
            ? error.message
            : invalid
              ? '输入格式不正确，请检查填写内容。'
              : conflict
                ? '已有正在进行的记录，请载入最新状态。'
                : status === 500
                  ? '服务暂时无法完成操作，请重试。'
                  : err.message,
      },
    });
  });

  try {
    await store.migrate();
    boss = await createBoss(options.url || process.env.DATABASE_URL!);
    const app = new Application(store, boss, folder, token);
    const mail = new MailActions(store, boss, folder);
    const devices = new DeviceActions(store, boss);
    const auth = new Authentication(store, folder);
    const agents = new AgentAccess(store);
    const bridges = new DeviceBridges(store);
    const bearerValid = (raw: string) => {
      const supplied = Buffer.from(raw.startsWith('Bearer ') ? raw.slice(7) : '');
      const expected = Buffer.from(token);
      return raw.startsWith('Bearer ') && supplied.length === expected.length && timingSafeEqual(supplied, expected);
    };
    const administrator = async (request: FastifyRequest) =>
      !request.headers.authorization && Boolean(await auth.username(sessionCookie(request.headers.cookie)));
    // An explicit Bearer identity never inherits privileges from a browser Cookie.
    const authorized = async (request: FastifyRequest) =>
      request.headers.authorization !== undefined ? bearerValid(request.headers.authorization) : administrator(request);

    server.post(
      '/api/v2/auth/login',
      {
        schema: { body: LoginInput },
        bodyLimit: 4096,
        onRequest: async (_request, reply) => {
          reply.header('Cache-Control', 'no-store');
        },
      },
      async (request, reply) => {
        const result = await auth.login(request.body.username, request.body.password);
        reply.header('Set-Cookie', cookieHeader(result.token, secureSession(request.protocol, externalOrigin)));
        return { username: result.username };
      },
    );
    // Liveness is independent of dependencies. Readiness checks the database, not the model or Worker.
    server.get('/healthz', async (_request, reply) =>
      reply.code(closing ? 503 : 200).send({ ok: !closing, version: 2 }),
    );
    server.get('/readyz', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        if (closing) throw new Error('closing');
        const probe = { text: 'SELECT 1', query_timeout: 3000 };
        await store.pool.query(probe);
        return { ok: true };
      } catch {
        return reply.code(503).send({ ok: false });
      }
    });

    // Authentication belongs to this Fastify scope, independent of raw URL spelling.
    // Every new business route must be registered here; login and probes stay outside it.
    await server.register(
      async (scope) => {
        const api = scope.withTypeProvider<ZodTypeProvider>();
        api.addHook('onRequest', async (request, reply) => {
          reply.header('Cache-Control', 'no-store');
          if (!(await authorized(request)))
            return reply.code(401).send({ error: { code: 'unauthorized', message: '请登录管理员账号。' } });
        });
        api.get('/auth/session', async (request) => ({
          username: await auth.username(sessionCookie(request.headers.cookie)),
        }));
        api.post('/auth/logout', async (request, reply) => {
          await auth.logout(sessionCookie(request.headers.cookie));
          reply.header('Set-Cookie', cookieHeader('', secureSession(request.protocol, externalOrigin), true));
          return { ok: true };
        });
        registerLearningRoutes(api, app);
        registerSourceRoutes(api, app, folder);
        registerOrganizationRoutes(api, app, store);
        registerIntegrationRoutes(api, app, mail, folder);
        registerDeviceRoutes(api, devices);
        registerDeviceBridgeManagement(api, bridges, administrator);
        registerStatusRoutes(api, store);
        registerAgentManagement(api, agents, administrator);
        registerEventRoutes(api, app, authorized);
      },
      { prefix: '/api/v2' },
    );

    await registerAgentRoutes(server, app, agents);
    await registerDeviceBridgeRoutes(server, bridges);

    if (options.assets !== false && existsSync(resolve('dist/web/index.html'))) {
      await server.register(staticFiles, { root: resolve('dist/web'), index: 'index.html', wildcard: true });
      server.setNotFoundHandler((request, reply) =>
        request.url.startsWith('/api/') ||
        request.url.startsWith('/assets/') ||
        /\.[a-z0-9]+(?:\?|$)/i.test(request.url)
          ? reply.code(404).send({ error: { code: 'not_found', message: '请求的内容不存在，请刷新页面。' } })
          : reply.sendFile('index.html'),
      );
    }
    return { server, app, store, boss, mail, devices, agents, bridges };
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
}
