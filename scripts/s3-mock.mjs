// Stand-in for S3-compatible storage (Backblaze B2 / S3 / R2), used only by the local smoke test.
// Keeps objects in memory. GET /__dump lists keys and sizes; DELETE /__dump clears everything.
import http from 'node:http';
const store = new Map();
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/__dump') {
      if (req.method === 'DELETE') store.clear();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([...store].map(([k, v]) => ({ key: k, size: v.body.length, type: v.type }))));
    }
    if (!/^AWS4-HMAC-SHA256 Credential=/.test(req.headers.authorization || '')) { res.writeHead(403); return res.end('<Error><Code>AccessDenied</Code><Message>No signature</Message></Error>'); }
    const [, bucket, ...rest] = u.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    if (bucket !== 'test-bucket') { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code><Message>No such bucket</Message></Error>'); }
    if (!key && req.method === 'GET' && u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') || '';
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}</ListBucketResult>`);
    }
    if (req.method === 'PUT') { store.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'] }); res.writeHead(200); return res.end(); }
    if (req.method === 'GET' && store.has(key)) { res.writeHead(200, { 'Content-Type': store.get(key).type }); return res.end(store.get(key).body); }
    if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); return res.end(); }
    res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>');
  });
}).listen(8798, () => console.log('s3 mock on 8798'));
