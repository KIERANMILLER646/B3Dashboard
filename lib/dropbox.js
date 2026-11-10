// Dropbox, limited to the app's own folder (Apps/B3 Dashboard). Used to see what photos, video and
// planning notes are there, and to hand Upload-Post a link to a file. Read-only apart from making links.
const { need } = require('./config');

let _fetch = (...a) => fetch(...a);
let cached = null;                                   // { token, exp }
const basic = () => `Basic ${Buffer.from(`${need('DROPBOX_APP_KEY')}:${need('DROPBOX_APP_SECRET')}`).toString('base64')}`;
const configured = () => !!(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET && process.env.DROPBOX_REFRESH_TOKEN);

async function token(body) {
  const res = await _fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Dropbox sign-in: ${json.error_description || json.error || res.status}`), { status: res.status });
  return json;
}
// Swap the one-time code Dropbox gives after approval for a lasting token.
const exchangeCode = (code, redirectUri) => token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
async function accessToken() {
  if (cached && cached.exp > Date.now() + 60e3) return cached.token;
  const j = await token({ grant_type: 'refresh_token', refresh_token: need('DROPBOX_REFRESH_TOKEN') });
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}
async function rpc(path, body) {
  const res = await _fetch(`https://api.dropboxapi.com/2/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Dropbox ${path}: ${json.error_summary || res.status}`), { status: res.status, summary: json.error_summary || '' });
  return json;
}

const KIND = { jpg: 'photo', jpeg: 'photo', png: 'photo', webp: 'photo', heic: 'photo', mp4: 'video', mov: 'video', m4v: 'video', md: 'note', txt: 'note', pdf: 'document', docx: 'document' };
const kindOf = (name) => KIND[String(name).split('.').pop().toLowerCase()] || 'other';

// Every file in the app folder (or one subfolder): { path, name, kind, size, modified }.
async function listFiles(folder = '') {
  const out = []; let r = await rpc('files/list_folder', { path: folder, recursive: true, limit: 1000 });
  for (;;) {
    for (const e of r.entries) if (e['.tag'] === 'file') out.push({ path: e.path_display, name: e.name, kind: kindOf(e.name), size: e.size, modified: e.server_modified });
    if (!r.has_more || out.length > 5000) break;
    r = await rpc('files/list_folder/continue', { cursor: r.cursor });
  }
  return out;
}

// A link Upload-Post can fetch the file from. Reuses the file's existing link if it has one.
async function directLink(path) {
  let url;
  try { url = (await rpc('sharing/create_shared_link_with_settings', { path, settings: { requested_visibility: 'public' } })).url; }
  catch (e) {
    if (!/shared_link_already_exists/.test(e.summary || '')) throw e;
    const r = await rpc('sharing/list_shared_links', { path, direct_only: true }); url = r.links && r.links[0] && r.links[0].url;
    if (!url) throw e;
  }
  const u = new URL(url); u.searchParams.delete('dl'); u.searchParams.set('raw', '1');
  return u.href;
}

module.exports = { configured, exchangeCode, listFiles, directLink, kindOf, _setFetch: (f) => { _fetch = f; cached = null; } };
