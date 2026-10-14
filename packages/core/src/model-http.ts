import { validateBaseURL } from './config.js';
import { AppError } from './common.js';

export function modelEndpoint(base: string) {
  const url = validateBaseURL(base);
  return url.endsWith('/chat/completions') ? url : url + '/chat/completions';
}

// Both the connection probe and actual learning calls have the same response bound.
export async function readModelResponse(response: Response) {
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) return readModelStream(response);
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('模型返回了空响应。', 503, 'model_invalid');
  const pieces: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > 256000) {
        await reader.cancel();
        throw new AppError('模型响应过大，已停止读取。', 400, 'model_invalid');
      }
      pieces.push(item.value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('模型响应读取失败或超时。', 503, 'model_unavailable');
  } finally {
    reader.releaseLock();
  }
  let result: any;
  try {
    result = JSON.parse(Buffer.concat(pieces).toString('utf8'));
  } catch {
    throw new AppError('模型响应不是有效 JSON。', 503, 'model_invalid');
  }
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new AppError('模型没有返回可用内容。', 503, 'model_invalid');
  return { content, usage: result.usage };
}

/**
 * A streamed reply (`stream: true`). Proxies such as Cloudflare end a request whose first byte takes
 * over 100 s (HTTP 524); streaming sends bytes as soon as the model starts, so long answers survive.
 * Only `delta.content` is kept: reasoning text, if a provider streams it, is not part of the answer.
 */
async function readModelStream(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('模型返回了空响应。', 503, 'model_invalid');
  const decoder = new TextDecoder();
  let buffer = '',
    content = '',
    usage: unknown = undefined,
    total = 0,
    finished = false;
  const line = (text: string) => {
    if (!text.startsWith('data:')) return;
    const data = text.slice(5).trim();
    if (data === '[DONE]') return void (finished = true);
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new AppError('模型流式响应格式无效。', 503, 'model_invalid');
    }
    if (chunk?.error) throw new AppError('模型在生成过程中返回错误，当前进度已保留。', 503, 'model_unavailable');
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') content += delta;
    if (chunk?.usage && typeof chunk.usage === 'object') usage = chunk.usage;
    if (content.length > 256000) throw new AppError('模型响应过大，已停止读取。', 400, 'model_invalid');
  };
  try {
    while (!finished) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      // Each streamed token carries an envelope, so the byte bound is wider than the content bound.
      if (total > 4_000_000) throw new AppError('模型响应过大，已停止读取。', 400, 'model_invalid');
      buffer += decoder.decode(item.value, { stream: true });
      let index: number;
      while (!finished && (index = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
      }
    }
    if (!finished && buffer.trim()) line(buffer.trim());
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError('模型响应读取失败或超时。', 503, 'model_unavailable');
  } finally {
    reader.releaseLock();
  }
  if (!content.trim()) throw new AppError('模型没有返回可用内容。', 503, 'model_invalid');
  return { content, usage };
}

/**
 * A short, single-line reason from a failed provider response, for the owner's error message.
 * Reads at most 2 KB, prefers `error.message`, and masks anything that looks like a credential.
 */
export async function providerReason(response: Response) {
  let text = '';
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const pieces: Uint8Array[] = [];
      let total = 0;
      while (total < 2048) {
        const item = await reader.read();
        if (item.done) break;
        pieces.push(item.value);
        total += item.value.byteLength;
      }
      await reader.cancel().catch(() => undefined);
      text = Buffer.concat(pieces).toString('utf8').slice(0, 2048);
    }
  } catch {
    return '';
  }
  let reason = text;
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    reason = typeof error === 'string' ? error : error?.message || parsed?.message || parsed?.detail || text;
  } catch {
    // Not JSON (for example an HTML error page); keep the plain text.
  }
  return String(reason)
    .replace(/<[^>]*>/g, ' ')
    .replace(/(Bearer\s+|sk-|xai-|key[=:]\s*)[A-Za-z0-9._-]{6,}/gi, '$1***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
