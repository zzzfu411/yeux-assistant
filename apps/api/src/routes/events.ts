import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { Application } from '../../../../packages/core/src/application.js';
import { AppError } from '../../../../packages/core/src/common.js';
import type { ApiServer } from './shared.js';
export function registerEventRoutes(server: ApiServer, app: Application, authorized: (request: FastifyRequest) => Promise<boolean>) {
    const connections = new Set<() => void>();
    server.get('/events', { schema: { querystring: z.object({ after: z.string().regex(/^\d+$/).max(19).refine(value => /^\d+$/.test(value) && BigInt(value) <= 9223372036854775807n).default('0') }) } }, async (r, p) => {
        if (connections.size >= 16)
            throw new AppError('打开的实时连接过多，请关闭不用的页面。', 429);
        p.hijack();
        p.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
        let after = r.query.after, busy = false, closed = false, blocked = false;
        let pressureTimer: ReturnType<typeof setTimeout> | undefined;
        const drain = () => { blocked = false; clearTimeout(pressureTimer); void flush(); };
        const cleanup = () => { if (closed)
            return; closed = true; clearInterval(poll); clearInterval(heartbeat); clearTimeout(pressureTimer); p.raw.off('drain', drain); connections.delete(stop); };
        const stop = () => { cleanup(); if (blocked)
            p.raw.destroy();
        else
            p.raw.end(); };
        const write = (frame: string) => { if (!p.raw.write(frame)) {
            blocked = true;
            pressureTimer = setTimeout(() => { cleanup(); p.raw.destroy(); }, 15000);
            return false;
        } return true; };
        const flush = async () => { if (busy || closed)
            return; busy = true; try {
            if (!await authorized(r)) {
                stop();
                return;
            }
            if (blocked)
                return;
            for (const item of await app.events(after)) {
                if (closed)
                    break;
                after = item.id;
                if (!write('id: ' + item.id + '\ndata: ' + JSON.stringify(item) + '\n\n'))
                    break;
            }
        }
        catch {
            stop();
        }
        finally {
            busy = false;
        } };
        const poll = setInterval(() => void flush(), 1000), heartbeat = setInterval(() => { if (!closed && !blocked)
            write(': heartbeat\n\n'); }, 15000);
        connections.add(stop);
        p.raw.on('close', cleanup);
        p.raw.on('drain', drain);
        write(': connected\n\n');
        await flush();
    });
    server.addHook('preClose', async () => { for (const close of connections)
        close(); });
}
