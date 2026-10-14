import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { EhallFields, ehallProfile } from '../packages/contracts/src/ehall.js';
import { z } from 'zod';

/** Synthetic, loopback-only acceptance fixture. Never proxies or contacts the university. */
export async function startEhallSimulator(port = 8777) {
  const state = {
    loggedIn: false,
    submitText: '提交',
    submissions: [] as Array<{ id: string; digest: string }>,
    forbidden: 0,
    delaySubmit: 0,
  };
  const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const html = (body: string) =>
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ehall 模拟站点</title><style>body{font:16px system-ui;max-width:720px;margin:32px auto;padding:16px;background:#f6f7fa;color:#202a36}button,input,textarea{font:inherit;padding:12px;margin:8px 0}label{display:grid}iframe{width:100%;height:500px;border:0;background:white}h1{font-size:24px}</style><h1>ehall 模拟站点</h1><p>仅含合成数据，不连接学校系统。</p>' +
    body +
    '</html>';
  const login = '<a href="/login">模拟登录</a>';
  const server = createServer(async (req, res) => {
    try {
      const path = req.url;
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET' && path === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 8192) {
            res.writeHead(413).end();
            return;
          }
        }
        if (path === '/api/login') {
          state.loggedIn = true;
          res.writeHead(303, { Location: '/' }).end();
          return;
        }
        if (/withdraw|delete|cancel|tuike/.test(path || '')) {
          state.forbidden++;
          res.end('forbidden fixture reached');
          return;
        }
        if (path === '/api/submit' && state.loggedIn) {
          const data = z.object({ id: z.string().uuid(), fields: EhallFields }).strict().parse(JSON.parse(body));
          if (!state.submissions.some((row) => row.id === data.id))
            state.submissions.push({
              id: data.id,
              digest: createHash('sha256')
                .update(JSON.stringify([ehallProfile.id, '1', '模拟学生', data.fields.applicant, data.fields.purpose]))
                .digest('hex'),
            });
          if (state.delaySubmit) await new Promise((resolve) => setTimeout(resolve, state.delaySubmit));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(403).end();
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (path === '/login') {
        res.end(html('<form method="POST" action="/api/login"><button>进入模拟账号</button></form>'));
        return;
      }
      if (!state.loggedIn) {
        res.end(html(login));
        return;
      }
      const account = '<p data-account="模拟学生">当前账号：模拟学生</p>';
      if (path === '/') {
        res.end(
          html(
            account +
              '<nav><a href="/query">课表</a> · <a href="/form">在读证明</a> · <a href="/status">申请记录</a></nav>',
          ),
        );
        return;
      }
      if (path === '/form') {
        res.end(html(account + '<iframe id="application" src="/frame"></iframe>'));
        return;
      }
      if (path === '/frame') {
        res.end(
          html(
            '<label>申请人<input id="applicant" maxlength="80"></label><label>用途<textarea id="purpose" maxlength="300"></textarea></label><label>附件（本轮不上传）<input type="file" id="proof" disabled></label><input id="command" aria-label="模拟执行编号"><p>' +
              ehallProfile.consequences +
              '</p><button id="submit">' +
              escape(state.submitText) +
              '</button><button id="withdraw">撤销申请</button><script>document.querySelector("#submit").onclick=async()=>{await fetch("/api/submit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:document.querySelector("#command").value,fields:{applicant:document.querySelector("#applicant").value,purpose:document.querySelector("#purpose").value}})});};document.querySelector("#withdraw").onclick=()=>fetch("/api/withdraw",{method:"POST"});</script>',
          ),
        );
        return;
      }
      if (path === '/query') {
        res.end(
          html(
            account +
              '<h2>模拟课表</h2><p data-course="生成式软件工程（模拟）" data-time="周一 10:00">生成式软件工程（模拟） · 周一 10:00</p>',
          ),
        );
        return;
      }
      if (path === '/status') {
        res.end(
          html(
            account +
              '<h2>模拟申请记录</h2>' +
              state.submissions
                .map(
                  (row) => '<p data-application="' + row.id + '" data-digest="' + row.digest + '">待审核（模拟）</p>',
                )
                .join(''),
          ),
        );
        return;
      }
      res.writeHead(404).end();
    } catch {
      res.writeHead(400).end();
    }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    state,
    origin: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
