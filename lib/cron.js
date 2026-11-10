// Vercel calls the scheduled routes with the project's CRON_SECRET. Anyone else is turned away.
const crypto = require('crypto');
function allowed(req) {
  const want = process.env.CRON_SECRET || '';
  const got = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
  if (want.length < 16 || !got) return false;
  const h = (x) => crypto.createHash('sha256').update(x).digest();
  return crypto.timingSafeEqual(h(got), h(want));
}
const send = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
const londonDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
module.exports = { allowed, send, londonDay };
