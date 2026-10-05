// Read-only connection probe. Never prints credentials, task data or raw remote errors.
const origin = process.env.YEUX_URL;
const token = process.env.YEUX_AGENT_TOKEN;
try {
  const url = new URL(origin || '');
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  ) {
    throw new Error('YEUX_URL 必须是 HTTPS 来源地址，或本机回环 HTTP 地址。');
  }
  if (!/^yeux_agent_[a-f0-9]{64}$/.test(token || ''))
    throw new Error('请在环境变量 YEUX_AGENT_TOKEN 中配置独立 Agent 令牌。');
  async function request(path, body) {
    const response = await fetch(new URL(path, url.origin), {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json, text/event-stream',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error('连接检查失败，HTTP ' + response.status + '。请核对地址、令牌期限与权限。');
    return response.json();
  }
  const http = await request('/api/agent/v1/tools');
  const mcp = await request('/api/agent/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'yeux-connection-check', version: '1.0.0' },
    },
  });
  if (!Array.isArray(http.tools) || mcp.result?.serverInfo?.name !== 'yeux-assitant')
    throw new Error('服务响应格式不符合预期。');
  console.log(JSON.stringify({ ok: true, http: true, mcp: true, tools: http.tools.map((tool) => tool.name) }, null, 2));
} catch (error) {
  console.error(
    error instanceof TypeError || error instanceof SyntaxError
      ? '连接失败，请检查 YEUX_URL、DNS、TLS 证书和服务状态。'
      : error.message,
  );
  process.exitCode = 1;
}
