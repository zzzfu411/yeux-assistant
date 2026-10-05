import type {
  FastifyInstance,
  FastifyBaseLogger,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { Id, Revision } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../../../../packages/core/src/common.js';
export type ApiServer = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;
export const params = z.object({ id: Id });
export const pageQuery = z.object({ page: z.coerce.number().int().min(0).max(100000).default(0) });
export const revisionBody = z.object({ revision: Revision }).strict();
export function key(request: FastifyRequest) {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string') throw new AppError('需要 Idempotency-Key。');
  return value;
}
