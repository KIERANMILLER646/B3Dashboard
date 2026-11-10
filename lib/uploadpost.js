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
  form.append('external_id', `b3-approval-${id}`);
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

// Sends an approved post. The approval id makes a repeat of the same send return the first one, not a second post.
async function publish(post, { id }) {
  const b = buildPost(post, { id });
  const r = await call('POST', b.path, b.form, { 'Idempotency-Key': `b3-approval-${id}` });
  return { request_id: r.request_id || null, job_id: r.job_id || null, scheduled: !!r.job_id, platforms: b.platforms, tiktok_draft: b.tiktokDraft };
}

async function analytics(platforms) {
  const q = new URLSearchParams({ platforms: platforms.join(',') });
  if (platforms.includes('facebook') && facebookPageId()) q.set('page_id', facebookPageId());
  return call('GET', `analytics/${encodeURIComponent(profile())}?${q}`);
}
async function reviews() { return call('GET', `uploadposts/google-business/reviews?user=${encodeURIComponent(profile())}&pageSize=1`); }

module.exports = { PostError, buildPost, publish, analytics, reviews, _setFetch: (f) => { _fetch = f; } };
