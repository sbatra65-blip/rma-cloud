// Stand-in for the Razorpay Orders API, used only by the local smoke test.
import http from 'node:http';
let n = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/v1/orders') {
      const b = JSON.parse(body || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `order_TEST${++n}`, amount: b.amount, currency: b.currency, receipt: b.receipt, status: 'created' }));
    } else { res.writeHead(404); res.end('{}'); }
  });
}).listen(8799, () => console.log('razorpay mock on 8799'));
