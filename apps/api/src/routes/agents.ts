import { z, ZodError } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyRequest } from 'fastify';
import type { Application } from '../../../../packages/core/src/application.js';
import { AgentAccess, type AgentPrincipal } from '../../../../packages/core/src/agents.js';
import { CreateAgent } from '../../../../packages/contracts/src/agents.js';
import { AppError } from '../../../../packages/core/src/common.js';
import { availableTools, invokeTool, toolDescriptor } from '../agent-tools.js';
import { type ApiServer, key, pageQuery } from './shared.js';

export function registerAgentManagement(server: ApiServer, access: AgentAccess, administrator: (request: FastifyRequest) => Promise<boolean>) {
  server.register(async scope => {
    const admin = scope.withTypeProvider<import('fastify-type-provider-zod').ZodTypeProvider>();
    admin.addHook('onRequest', async request => {
      if (!await administrator(request)) throw new AppError('请使用管理员账号登录后管理 Agent 连接。', 403, 'administrator_required');
    });
    admin.get('/', () => access.list());
    admin.post('/', { schema: { body: CreateAgent } }, request => access.issue(key(request), request.body));
    admin.post('/:id/revoke', { schema: { params: z.object({ id: z.string().uuid() }) } }, request => access.revoke(request.params.id));
    admin.get('/audit', { schema: { querystring: pageQuery } }, request => access.audit(request.query.page));
  }, { prefix: '/agents', prefixTrailingSlash: 'no-slash' });
}

/** A separate authenticated scope: neither admin Cookie nor the legacy admin token is accepted here. */
export async function registerAgentRoutes(server: ApiServer, app: Application, access: AgentAccess) {
  await server.register(async scope => {
    const api = scope.withTypeProvider<import('fastify-type-provider-zod').ZodTypeProvider>();
    const actors = new WeakMap<FastifyRequest, AgentPrincipal>();
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try { actors.set(request, await access.authenticate(request.headers.authorization)); }
      catch (error) {
        if (error instanceof AppError && error.status === 429) reply.header('Retry-After', '60');
        if (error instanceof AppError && error.status === 401) reply.header('WWW-Authenticate', 'Bearer');
        throw error;
      }
    });
    api.get('/v1/tools', async request => ({ tools: availableTools(actors.get(request)!).map(toolDescriptor) }));
    api.post('/v1/tools/:name', { schema: { params: z.object({ name: z.string().min(1).max(80) }) }, bodyLimit: 128000 }, request =>
      invokeTool(app, access, actors.get(request)!, request.params.name, request.body));
    // Short, stateless MCP requests enqueue long work and return IDs; polling uses the same permission checks.
    api.post('/mcp', { bodyLimit: 128000 }, async (request, reply) => {
      const actor = actors.get(request)!;
      const mcp = new Server({ name: 'yeux-assitant', version: '2.0.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: availableTools(actor).map(tool => ({
        name: tool.name, description: tool.description, inputSchema: toolDescriptor(tool).inputSchema as Tool['inputSchema'],
        annotations: { readOnlyHint: !tool.write, destructiveHint: false, idempotentHint: true, openWorldHint: tool.write },
      })) }));
      mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        // Validation and scope checks stay in the common invocation path, including denied calls.
        try {
          const value = await invokeTool(app, access, actor, params.name, params.arguments ?? {});
          return { content: [{ type: 'text', text: JSON.stringify(value) }] };
        } catch (error) {
          const code = error instanceof AppError ? error.code : error instanceof ZodError ? 'invalid_request' : 'internal_error';
          const message = error instanceof AppError ? error.message : error instanceof ZodError ? '输入格式不正确。' : '暂未完成操作，请使用同一 requestKey 重试。';
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }] };
        }
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await mcp.connect(transport);
        // The SDK owns this response. Apply headers that Fastify's onSend hook would normally add.
        reply.raw.setHeader('Cache-Control', 'no-store');
        reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
        reply.raw.setHeader('Referrer-Policy', 'no-referrer');
        reply.hijack();
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch {
        if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP 请求未完成，请使用原请求标识重试。' } }));
        else if (!reply.raw.writableEnded) reply.raw.destroy();
      } finally { await mcp.close(); }
    });
    for (const method of ['GET', 'DELETE'] as const) api.route({ method, url: '/mcp', handler: async (_request, reply) =>
      reply.header('Allow', 'POST').code(405).send({ error: { code: 'method_not_allowed', message: '此 MCP 入口使用无状态 POST 请求。' } }) });
  }, { prefix: '/api/agent' });
}
