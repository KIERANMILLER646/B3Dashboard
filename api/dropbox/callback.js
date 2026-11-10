// Dropbox sends the owner back here after they approve. Shows the lasting token once, to be pasted into Vercel.
const dbx = require('../../lib/dropbox');
const { page } = require('./connect');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = async (req, res) => {
  const url = new URL(req.url, 'https://x');
  const cookie = (String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('b3dbx=')) || '').slice(6);
  const state = url.searchParams.get('state') || '';
  if (!cookie || cookie !== state) return page(res, 400, 'That link has expired', '<p>Open <a style="color:#FF6A13" href="/api/dropbox/connect">the connect page</a> and try again.</p>');
  if (!url.searchParams.get('code')) return page(res, 400, 'Dropbox was not approved', '<p>Nothing was connected. Open <a style="color:#FF6A13" href="/api/dropbox/connect">the connect page</a> to try again.</p>');
  try {
    const redirect = `https://${req.headers['x-forwarded-host'] || req.headers.host}/api/dropbox/callback`;
    const j = await dbx.exchangeCode(url.searchParams.get('code'), redirect);
    if (!j.refresh_token) throw new Error('no lasting token returned');
    res.setHeader('Set-Cookie', 'b3dbx=; Path=/api/dropbox; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return page(res, 200, 'One last step', `<p>Dropbox approved the connection. Copy the token below into the <b>B3Dashboard</b> project in Vercel as <code>DROPBOX_REFRESH_TOKEN</code> (Production only), then redeploy.</p>
      <textarea readonly rows="4" style="width:100%;font:14px ui-monospace,monospace;background:#161A18;color:#E8ECE4;border:1px solid #444;border-radius:10px;padding:12px" onclick="this.select()">${esc(j.refresh_token)}</textarea>
      <p>This token only reaches the <b>Apps/B3 Dashboard</b> folder. It is shown once: close this page when you have saved it, and don't share it.</p>`);
  } catch (e) { return page(res, 502, 'Dropbox could not finish connecting', `<p>${esc(String(e.message).slice(0, 160))}</p><p>Open <a style="color:#FF6A13" href="/api/dropbox/connect">the connect page</a> to try again.</p>`); }
};
