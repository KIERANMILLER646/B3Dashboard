// Upload-Post: one API for posting to and reading numbers from Instagram, Facebook, Google Business and TikTok.
// Always the B3 profile. Media is passed as a public https link, never as a file.
const { need, profile, facebookPageId, tiktokDirect, PLATFORMS } = require('./config');
const API = 'https://api.upload-post.com/api';

let _fetch = (...a) => fetch(...a);
async function call(method, path, form, headers = {}) {
  const res = await _fetch(`${API}/${path}`, { method, headers: { Authorization: `Apikey ${need('UPLOAD_POST_API_KEY')}`, ...headers }, body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Upload-Post ${path.split('?')[0]}: ${res.status} ${json.message || json.error || ''}`.trim()), { status: res.status, body: json });
  return json;
}

class PostError extends Error {}
const requestId = (id) => `b3-approval-${id}`;
const isHttps = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };

// Checks an approved post and turns it into the form Upload-Post expects. Pure: no network.
// post: { platforms[], caption, title?, media: [{ type: 'video'|'photo', url }], scheduled_for? }
function buildPost(post, { id, now = new Date() } = {}) {
  if (!post || typeof post !== 'object') throw new PostError('The post has no details.');
  const platforms = [...new Set(Array.isArray(post.platforms) ? post.platforms : [])];
  if (!platforms.length) throw new PostError('The post names no networks.');
  const bad = platforms.filter((p) => !PLATFORMS.includes(p));
  if (bad.length) throw new PostError(`Not a network this dashboard posts to: ${bad.join(', ')}.`);
  const caption = typeof post.caption === 'string' ? post.caption.trim() : '';
  if (!caption) throw new PostError('The post has no caption.');
  if (caption.length > 2200) throw new PostError('The caption is over 2,200 characters.');
  const media = Array.isArray(post.media) ? post.media : [];
  if (media.some((m) => !m || !['video', 'photo'].includes(m.type) || !isHttps(m.url))) throw new PostError('Each piece of media needs a type (video or photo) and an https link.');
  const videos = media.filter((m) => m.type === 'video'), photos = media.filter((m) => m.type === 'photo');
  if (videos.length && photos.length) throw new PostError('A post can be one video or a set of photos, not both.');
  if (videos.length > 1) throw new PostError('A post can have one video.');
  if (photos.length > 10) throw new PostError('A post can have at most 10 photos.');
  if (!media.length && platforms.some((p) => p === 'instagram' || p === 'tiktok')) throw new PostError('Instagram and TikTok need a video or photo.');
  const form = new FormData();
  form.append('user', profile());
  for (const p of platforms) form.append('platform[]', p);
  form.append('title', caption);
  form.append('async_upload', 'true');
  form.append('external_id', requestId(id));
  form.append('request_id', requestId(id));   // our own id, so the result can be looked up on any later run
  if (post.scheduled_for) {
    const when = new Date(post.scheduled_for);
    if (isNaN(when)) throw new PostError('The time to post is not a date.');
    if (when - now > 5 * 60e3) form.append('scheduled_date', when.toISOString());   // anything due within five minutes goes now
  }
  if (platforms.includes('facebook') && facebookPageId()) form.append('facebook_page_id', facebookPageId());
  if (platforms.includes('tiktok') && !tiktokDirect()) form.append('post_mode', 'MEDIA_UPLOAD');   // TikTok drafts: finished and published in the app
  let path = 'upload_text';
  if (videos.length) { path = 'upload'; form.append('video', videos[0].url); }
  else if (photos.length) { path = 'upload_photos'; for (const p of photos) form.append('photos[]', p.url); }
  return { path, form, platforms, tiktokDraft: platforms.includes('tiktok') && !tiktokDirect() };
}

// Sends an approved post. Upload-Post works on it in the background; `status` and `outcome` say how it went.
// The approval id is both the request id and the Idempotency-Key, so a repeat of the same send returns the first one.
async function publish(post, { id, now = new Date() }) {
  const b = buildPost(post, { id, now });
  const r = await call('POST', b.path, b.form, { 'Idempotency-Key': requestId(id), 'X-Request-Id': requestId(id) });
  return { request_id: r.request_id || requestId(id), job_id: r.job_id || null, platforms: b.platforms, tiktok_draft: b.tiktokDraft };
}

// What Upload-Post knows about a send. null means it has no record of it, so it was never sent.
async function status(id) {
  try { return await call('GET', `uploadposts/status?request_id=${encodeURIComponent(requestId(id))}`); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

// Reads a status answer for the networks the post was sent to. Returns null while Upload-Post is still working,
// otherwise { ok, partial, networks: [{ platform, ok, message, post_url }], text }. A network that was skipped
// (no account connected) or has no result counts as not posted. Pure.
const NAMES = { instagram: 'Instagram', facebook: 'Facebook', google_business: 'Google Business', tiktok: 'TikTok' };
const FINAL = ['completed', 'failed'];
function outcome(st, platforms) {
  if (!st || !FINAL.includes(String(st.status))) return null;
  const results = Array.isArray(st.results) ? st.results : [];
  const short = (m) => String(m || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const networks = platforms.map((platform) => {
    const r = results.find((x) => x && x.platform === platform);
    if (!r) return { platform, ok: false, message: short(st.message) || 'no result reported' };
    const s = String(r.status || '');
    if (r.skipped || s === 'skipped') return { platform, ok: false, message: r.skip_reason === 'profile_platform_not_configured' ? 'no account connected to the B3 profile' : short(r.skip_reason || r.message) || 'skipped' };
    const ok = s ? s === 'completed' : r.success === true;
    return { platform, ok, message: ok ? '' : short(r.message) || s || 'failed', ...(r.post_url ? { post_url: String(r.post_url) } : {}) };
  });
  const good = networks.filter((n) => n.ok), bad = networks.filter((n) => !n.ok);
  const text = [good.length ? `${good.map((n) => NAMES[n.platform] || n.platform).join(' and ')} posted` : '', ...bad.map((n) => `${NAMES[n.platform] || n.platform} failed: ${n.message}`)].filter(Boolean).join('; ');
  return { ok: networks.length > 0 && !bad.length, partial: good.length > 0 && bad.length > 0, networks, text: text || 'no networks reported' };
}

async function analytics(platforms) {
  const q = new URLSearchParams({ platforms: platforms.join(',') });
  if (platforms.includes('facebook') && facebookPageId()) q.set('page_id', facebookPageId());
  return call('GET', `analytics/${encodeURIComponent(profile())}?${q}`);
}
async function reviews() { return call('GET', `uploadposts/google-business/reviews?user=${encodeURIComponent(profile())}&pageSize=1`); }

module.exports = { PostError, requestId, buildPost, publish, status, outcome, analytics, reviews, _setFetch: (f) => { _fetch = f; } };
