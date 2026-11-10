// Links the B3 Dashboard Dropbox app to the owner's Dropbox. Open this page once, approve in Dropbox, and the
// page that follows shows a token to paste into Vercel. Whoever approves only ever gets a token for their own
// Dropbox app folder, so the page needs no login of its own. If Dropbox is already linked, it says so.
const crypto = require('crypto');
const dbx = require('../../lib/dropbox');

const page = (res, status, title, body) => { res.statusCode = status; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(`<!doctype html><html lang="en-GB"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><body style="margin:0;background:#0E1110;color:#E8ECE4;font:16px/1.6 system-ui,sans-serif"><main style="max-width:560px;margin:0 auto;padding:40px 20px"><h1 style="font-size:1.4rem">${title}</h1>${body}</main></body></html>`); };

module.exports = async (req, res) => {
  if (!process.env.DROPBOX_APP_KEY || !process.env.DROPBOX_APP_SECRET) return page(res, 503, 'Dropbox is not set up yet', '<p>Add <code>DROPBOX_APP_KEY</code> and <code>DROPBOX_APP_SECRET</code> to this project in Vercel, redeploy, then open this page again.</p>');
  if (dbx.configured()) {
    try { const files = await dbx.listFiles(''); const n = (k) => files.filter((f) => f.kind === k).length;
      return page(res, 200, 'Dropbox is connected', `<p>The dashboard can see the <b>Apps/B3 Dashboard</b> folder: ${n('photo')} photos, ${n('video')} videos and ${n('note') + n('document')} notes or documents.</p>`); }
    catch (e) { return page(res, 502, 'Dropbox is set up but not answering', '<p>The saved token was refused. Remove <code>DROPBOX_REFRESH_TOKEN</code> in Vercel, redeploy, and open this page again to reconnect.</p>'); }
  }
  const state = crypto.randomBytes(16).toString('hex');
  const redirect = `https://${req.headers['x-forwarded-host'] || req.headers.host}/api/dropbox/callback`;
  res.statusCode = 302;
  res.setHeader('Set-Cookie', `b3dbx=${state}; Path=/api/dropbox; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  res.setHeader('Location', 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({ client_id: process.env.DROPBOX_APP_KEY, response_type: 'code', token_access_type: 'offline', redirect_uri: redirect, state }));
  res.end();
};
module.exports.page = page;
