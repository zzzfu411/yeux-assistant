import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Store } from '../../storage/src/index.js';
import type { RunIdentity } from './runtime-state.js';
import { executeResearchRun } from './research/service.js';
import { executeMailReplyRun } from './mail/reply.js';
import { executeErrandRun } from './errands/service.js';
import { executeLearningRun } from './learning.js';

type Executor = (store: Store, folder: string, identity: RunIdentity, saver: PostgresSaver) => Promise<void>;
export type ExecutorKind = 'research' | 'mail-reply' | 'errand' | 'learning';

/**
 * Every session kind has exactly one executor. They share the fenced run identity, its budget, the
 * step receipts in app.run_steps and the model-call trace; only learning keeps a LangGraph graph,
 * because it pauses inside the graph until the owner answers an exercise.
 */
export const EXECUTORS: Record<ExecutorKind, Executor> = {
  research: (store, folder, identity) => executeResearchRun(store, folder, identity),
  'mail-reply': (store, folder, identity) => executeMailReplyRun(store, folder, identity),
  errand: (store, folder, identity) => executeErrandRun(store, folder, identity),
  learning: executeLearningRun,
};
export function executorKind(session: { research?: unknown; flow?: string | null }): ExecutorKind {
  if (session.research) return 'research';
  if (session.flow === 'mail-reply' || session.flow === 'errand') return session.flow;
  return 'learning';
}
