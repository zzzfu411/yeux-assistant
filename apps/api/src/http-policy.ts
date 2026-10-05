import type { FastifyRequest } from 'fastify';
import { AppError } from '../../../packages/core/src/common.js';

/** A configured external origin avoids trusting arbitrary forwarded headers. */
export function publicOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('ASSISTANT_PUBLIC_ORIGIN 必须是完整的 HTTP(S) 来源地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('ASSISTANT_PUBLIC_ORIGIN 不接受账号、路径、查询参数或片段。');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('远程访问必须配置 HTTPS 来源；HTTP 只用于服务器本机的回环地址。');
  }
  return url.origin;
}

export function checkOrigin(request: FastifyRequest, externalOrigin?: string) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || !request.headers.origin) return;
  let supplied: URL, expected: URL;
  try {
    supplied = new URL(request.headers.origin);
    expected = new URL(externalOrigin || `${request.protocol}://${request.headers.host}`);
  } catch { throw new AppError('请求来源无效。', 403, 'origin_mismatch'); }
  if (supplied.origin !== expected.origin || supplied.username || supplied.password || supplied.pathname !== '/' || supplied.search || supplied.hash) {
    throw new AppError('请求来源与当前服务不一致。', 403, 'origin_mismatch');
  }
}

export const secureSession = (protocol: string, externalOrigin?: string) => externalOrigin ? externalOrigin.startsWith('https://') : protocol === 'https';
