import { z } from 'zod';

export const AgentScope = z.enum([
  'workspace:read',
  'sources:read',
  'goals:create',
  'tasks:create',
  'devices:read',
  'devices:request',
]);
export type AgentScope = z.infer<typeof AgentScope>;
export const agentScopeLabels: Record<AgentScope, string> = {
  'workspace:read': '读取目标和任务',
  'sources:read': '检索和阅读资料',
  'devices:read': '读取设备与操作记录',
  'devices:request': '提出设备操作（须本人确认）',
  'goals:create': '创建学习目标',
  'tasks:create': '准备工作与管理任务',
};
export const CreateAgent = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(AgentScope).min(1).max(6),
    expiresInDays: z.number().int().min(1).max(90).default(30),
    dailyWriteLimit: z.number().int().min(1).max(100).default(10),
  })
  .strict()
  .refine((data) => !data.scopes.some((scope) => scope.endsWith(':create')) || data.scopes.includes('workspace:read'), {
    message: '允许创建时，请同时允许读取目标和任务，以便获取处理结果。',
    path: ['scopes'],
  })
  .refine((data) => !data.scopes.includes('devices:request') || data.scopes.includes('devices:read'), {
    message: '提出设备操作时，请同时允许读取设备与操作记录。',
    path: ['scopes'],
  });
export const AgentCredential = z.object({
  id: z.string().uuid(),
  name: z.string(),
  scopes: z.array(AgentScope),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  dailyWriteLimit: z.number(),
  writesToday: z.number(),
  active: z.boolean(),
});
export type AgentCredential = z.infer<typeof AgentCredential>;
export type IssuedAgent = { credential: AgentCredential; token: string | null };
export type AgentAudit = {
  id: string;
  agentId: string;
  agentName: string;
  operation: string;
  outcome: 'started' | 'succeeded' | 'failed' | 'denied' | 'limited';
  errorCode: string | null;
  entityId: string | null;
  createdAt: string;
};
export const AgentRequestKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,100}$/, '请求标识需要 8–100 位字母、数字、下划线或连字符。');
