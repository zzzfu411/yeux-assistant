import { createContext, useCallback, useContext, useEffect, useRef, useState, type SetStateAction } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { RunEvent } from '../../../packages/contracts/src/index';
import { ZodError } from 'zod';
import { affected, useLive } from './live';

const prefix = 'assistant.v2.';
export const storage = {
  get(key: string) {
    try {
      return sessionStorage.getItem(prefix + key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      sessionStorage.setItem(prefix + key, value);
    } catch {
      /* Storage may be disabled; the current page still works. */
    }
  },
  remove(key: string) {
    try {
      sessionStorage.removeItem(prefix + key);
    } catch {}
  },
  clear() {
    try {
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith(prefix) || key === 'gse-token') sessionStorage.removeItem(key);
    } catch {}
  },
};
function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
// Only a request fingerprint is persisted, never the request body or a model key.
function fingerprint(text: string) {
  return [2166136261, 2246822507, 3266489909, 668265263]
    .map((seed) => {
      let h = seed;
      for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
      return (h >>> 0).toString(16).padStart(8, '0');
    })
    .join('');
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = 'network',
  ) {
    super(message);
  }
}
export class ApiClient {
  readonly lifetime = new AbortController();
  constructor(readonly token: string) {}
  dispose() {
    this.lifetime.abort();
  }
  async request<T>(
    path: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal; raw?: boolean; blob?: boolean } = {},
  ): Promise<T> {
    const method = options.method || 'GET',
      encoded = options.body === undefined ? undefined : JSON.stringify(options.body);
    const signature = 'request.' + fingerprint(method + ' ' + path + ' ' + (encoded || ''));
    const key = method === 'GET' ? undefined : storage.get(signature) || nonce();
    if (key) storage.set(signature, key);
    const controller = new AbortController(),
      abort = () => controller.abort();
    const signals = [this.lifetime.signal, options.signal].filter((s): s is AbortSignal => Boolean(s));
    for (const signal of signals) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    const timeout = setTimeout(abort, 20_000);
    try {
      const response = await fetch('/api/v2' + path, {
        method,
        body: encoded,
        signal: controller.signal,
        headers: {
          ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
          ...(encoded !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
      });
      if (this.lifetime.signal.aborted) throw new DOMException('已退出', 'AbortError');
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        if (response.status < 500) storage.remove(signature);
        throw new ApiError(
          error?.error?.message || '请求未完成，请重试。',
          response.status,
          error?.error?.code || 'http',
        );
      }
      const value = options.blob ? await response.blob() : options.raw ? await response.text() : await response.json();
      if (this.lifetime.signal.aborted || options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      if (key) storage.remove(signature);
      return value as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (this.lifetime.signal.aborted || options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      throw new ApiError(
        method === 'GET' ? '暂时无法连接，请重试。' : '暂未收到结果，输入已保留。重试会核对原请求，避免重复创建。',
      );
    } finally {
      clearTimeout(timeout);
      for (const signal of signals) signal.removeEventListener('abort', abort);
    }
  }
  get<T>(path: string, signal?: AbortSignal) {
    return this.request<T>(path, { signal });
  }
  downloadBlob(path: string, signal?: AbortSignal) {
    return this.request<Blob>(path, { signal, blob: true });
  }
  write<T = Record<string, unknown>>(path: string, body: unknown = {}, method = 'POST') {
    return this.request<T>(path, { method, body });
  }
}
export const ApiContext = createContext<ApiClient | null>(null);
export function useApi() {
  const api = useContext(ApiContext);
  if (!api) throw new Error('No API client');
  return api;
}
/**
 * A read keyed by its path. `refetchInterval` applies only while the event stream is down; while it is
 * connected, events refresh the read and `whileLive` (default: never) is the only polling left, for
 * values that change without an event, such as a running task's elapsed time.
 */
export function useData<T>(
  path: string,
  options: { refetchInterval?: number; whileLive?: number | false | ((data: T | undefined) => number | false) } = {},
) {
  const api = useApi(),
    live = useLive();
  return useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api.get<T>(path, signal),
    retry: 1,
    staleTime: 15_000,
    refetchInterval: (query) => {
      if (!live) return options.refetchInterval ?? false;
      const whileLive = options.whileLive;
      return typeof whileLive === 'function' ? whileLive(query.state.data as T | undefined) : (whileLive ?? false);
    },
  });
}
export function useDraft<T>(key: string, initial: T) {
  const [value, update] = useState<T>(() => {
    try {
      const saved = storage.get('draft.' + key);
      return saved ? (JSON.parse(saved) as T) : initial;
    } catch {
      return initial;
    }
  });
  const current = useRef(value);
  current.current = value;
  const setValue = useCallback(
    (next: SetStateAction<T>) => {
      const changed = typeof next === 'function' ? (next as (current: T) => T)(current.current) : next;
      current.current = changed;
      storage.set('draft.' + key, JSON.stringify(changed));
      update(changed);
    },
    [key],
  );
  useEffect(() => storage.set('draft.' + key, JSON.stringify(value)), [key, value]);
  const clear = () => storage.remove('draft.' + key);
  return [value, setValue, clear] as const;
}
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [message, setMessage] = useState('');
  const alive = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function run<T>(work: () => Promise<T>, done?: (result: T) => void) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const result = await work();
      if (alive.current) done?.(result);
      return result;
    } catch (e) {
      if (alive.current && !(e instanceof DOMException && e.name === 'AbortError'))
        setError(
          e instanceof ZodError
            ? new Error('请检查填写内容：' + (e.issues[0]?.path.join('.') || '输入') + ' 未符合要求。')
            : e instanceof Error
              ? e
              : new Error('操作未完成。'),
        );
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return { busy, error, message, setError, setMessage, run };
}
export function useEvents(api: ApiClient, client: QueryClient, onExpired: () => void) {
  const [connected, setConnected] = useState(false),
    expired = useRef(onExpired);
  expired.current = onExpired;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cursor = storage.get('cursor') || '0';
    let pending: Array<(path: string) => boolean> = [];
    // Each event refreshes only the reads it can change; a reconnect refreshes everything once.
    const invalidate = (kind?: string) => {
      pending.push(kind === undefined ? () => true : affected(kind));
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          const tests = pending;
          pending = [];
          void client.invalidateQueries({
            predicate: (query) => {
              const path = query.queryKey[0];
              return typeof path !== 'string' || tests.some((test) => test(path));
            },
          });
        }, 150);
    };
    const wait = () =>
      new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(retryTimer);
          controller.signal.removeEventListener('abort', finish);
          resolve();
        };
        retryTimer = setTimeout(finish, 2500);
        controller.signal.addEventListener('abort', finish, { once: true });
      });
    async function connect() {
      while (!controller.signal.aborted) {
        const connection = new AbortController();
        let watchdog: ReturnType<typeof setTimeout>;
        const abort = () => connection.abort();
        controller.signal.addEventListener('abort', abort, { once: true });
        const heartbeat = () => {
          clearTimeout(watchdog);
          watchdog = setTimeout(abort, 45_000);
        };
        heartbeat();
        try {
          const response = await fetch('/api/v2/events?after=' + encodeURIComponent(cursor), {
            signal: connection.signal,
            headers: { ...(api.token ? { Authorization: 'Bearer ' + api.token } : {}), Accept: 'text/event-stream' },
          });
          if (response.status === 401) {
            expired.current();
            return;
          }
          if (!response.ok || !response.body) throw new Error('stream unavailable');
          setConnected(true);
          const reader = response.body.getReader(),
            decoder = new TextDecoder();
          let buffer = '';
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            heartbeat();
            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (!data) continue;
              try {
                const event = RunEvent.parse(JSON.parse(data));
                cursor = event.id;
                storage.set('cursor', cursor);
                invalidate(event.kind);
              } catch {
                /* Ignore heartbeat and unknown frames. */
              }
            }
          }
        } catch {
          /* The next connection resumes from the last durable event. */
        } finally {
          clearTimeout(watchdog!);
          controller.signal.removeEventListener('abort', abort);
          connection.abort();
        }
        if (!controller.signal.aborted) {
          setConnected(false);
          invalidate();
          await wait();
        }
      }
    }
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(retryTimer);
    };
  }, [api, client]);
  return connected;
}

export async function authRequest(path: string, body?: unknown) {
  try {
    const response = await fetch('/api/v2/auth/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok)
      throw new ApiError(result?.error?.message || '登录请求未完成。', response.status, result?.error?.code || 'auth');
    return result as { username: string };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('暂时无法连接助手，请确认电脑上的服务已启动。');
  }
}
