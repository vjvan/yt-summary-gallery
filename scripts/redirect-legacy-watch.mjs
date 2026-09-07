// A navigation-only alias. Never forwards API requests, bodies, or pairing keys.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export function legacyWatchReply({ method, host, url }, { port = 3111, targetPort = 3000 } = {}) {
  if (!['127.0.0.1', 'localhost', '[::1]'].some(name => host === `${name}:${port}`)) {
    return { status: 403, headers: {}, body: '此入口僅供本機使用。' };
  }
  if (!['GET', 'HEAD'].includes(method) || !url?.startsWith('/') || url.startsWith('//') || /[\r\n]/.test(url)) {
    return { status: 409, headers: {}, body: '舊測試服務已停用。請開啟 http://127.0.0.1:3000；不會轉送舊頁的 API 或配對資料。' };
  }
  const path = new URL(url, `http://127.0.0.1:${port}`);
  if (path.pathname.startsWith('/api/') || path.pathname.startsWith('/_next/')) {
    return { status: 409, headers: {}, body: '請重新整理此分頁，改用目前的 3000 服務。舊 API 不會被轉送。' };
  }
  return {
    status: 307, headers: { Location: `http://127.0.0.1:${targetPort}${path.pathname}${path.search}` }, body: '正在前往目前的影片字幕翻譯庫。',
  };
}

export function startLegacyWatchRedirect(port = 3111, targetPort = 3000) {
  for (const value of [port, targetPort]) if (!Number.isInteger(value) || value < 1024 || value > 65535) throw Error('本機連接埠設定無效。');
  if (port === targetPort) throw Error('舊入口與目前服務不可使用相同連接埠。');
  const server = createServer((req, res) => {
    const result = legacyWatchReply({method:req.method, host:req.headers.host, url:req.url}, {port,targetPort});
    res.writeHead(result.status, {'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store',...result.headers});
    res.end(req.method === 'HEAD' ? undefined : result.body);
  });
  server.on('error', error => { console.error(`舊入口未啟動：${error.code || 'UNKNOWN'}。不會終止或覆寫占用該連接埠的其他程序。`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`舊入口 ${port} → 目前服務 ${targetPort}（僅網頁導向，不轉送 API）`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = startLegacyWatchRedirect(Number(process.argv[2] || 3111), Number(process.argv[3] || 3000));
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}
