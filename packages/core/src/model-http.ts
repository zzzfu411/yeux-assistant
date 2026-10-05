import { validateBaseURL } from './config.js';
import { AppError } from './common.js';

export function modelEndpoint(base: string) {
  const url = validateBaseURL(base);
  return url.endsWith('/chat/completions') ? url : url + '/chat/completions';
}

// Both the connection probe and actual learning calls have the same response bound.
export async function readModelResponse(response: Response) {
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
