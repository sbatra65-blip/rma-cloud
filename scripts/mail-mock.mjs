// Stand-in for the Resend email API, for local tests and guide screenshots. Keeps sent emails in memory.
// GET /__mail lists them (newest last); GET /__mail/<n>.html shows one as a page.
import http from 'node:http';
const mails = [];
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/emails') {
      try { mails.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: `mock_${mails.length}` }));
    }
    const m = u.pathname.match(/^\/__mail\/(\d+)\.html$/);
    if (m && mails[Number(m[1])]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(mails[Number(m[1])].html || ''); }
    if (u.pathname === '/__mail') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(mails.map((x, i) => ({ i, to: x.to, subject: x.subject, attachments: (x.attachments || []).map((a) => a.filename) }))));
    }
    res.writeHead(404); res.end();
  });
}).listen(8797, () => console.log('mail mock on 8797'));
