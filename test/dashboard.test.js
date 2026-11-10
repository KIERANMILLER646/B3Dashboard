const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DASHBOARD_AGENT_TOKEN = 't'.repeat(40); process.env.UPLOAD_POST_API_KEY = 'k'.repeat(20); process.env.CRON_SECRET = 'c'.repeat(20);
process.env.FACEBOOK_PAGE_ID = '123'; delete process.env.TIKTOK_MODE; delete process.env.UPLOAD_POST_PROFILE;
const up = require('../lib/uploadpost');
const site = require('../lib/site');
const jobs = require('../lib/jobs');
const { rowsFrom } = require('../lib/metrics');
const { allowed } = require('../lib/cron');

const form = (f) => { const o = {}; for (const [k, v] of f.entries()) (o[k] = o[k] || []).push(v); return o; };
const post = { platforms: ['instagram', 'facebook', 'tiktok'], caption: 'Grip it like toothpaste.', media: [{ type: 'video', url: 'https://files.example.test/a.mp4' }] };

test('an approved video post becomes one Upload-Post request for the B3 profile, TikTok to drafts', () => {
  const b = up.buildPost(post, { id: 7 }); const f = form(b.form);
  assert.equal(b.path, 'upload'); assert.deepEqual(f.user, ['default']); assert.deepEqual(f['platform[]'], ['instagram', 'facebook', 'tiktok']);
  assert.deepEqual(f.video, ['https://files.example.test/a.mp4']); assert.deepEqual(f.post_mode, ['MEDIA_UPLOAD']);
  assert.deepEqual(f.facebook_page_id, ['123']); assert.deepEqual(f.external_id, ['b3-approval-7']); assert.equal(f.scheduled_date, undefined);
  process.env.TIKTOK_MODE = 'direct'; assert.equal(form(up.buildPost(post, { id: 7 }).form).post_mode, undefined); delete process.env.TIKTOK_MODE;
});

test('photos, text and scheduling; anything odd is refused before it is sent', () => {
  assert.equal(up.buildPost({ ...post, media: [{ type: 'photo', url: 'https://x.example.test/1.jpg' }, { type: 'photo', url: 'https://x.example.test/2.jpg' }] }, { id: 1 }).path, 'upload_photos');
  assert.equal(up.buildPost({ platforms: ['facebook', 'google_business'], caption: 'Open late on Friday.' }, { id: 1 }).path, 'upload_text');
  const now = new Date('2031-01-01T10:00:00Z');
  assert.deepEqual(form(up.buildPost({ ...post, scheduled_for: '2031-01-02T18:00:00Z' }, { id: 1, now }).form).scheduled_date, ['2031-01-02T18:00:00.000Z']);
  assert.equal(form(up.buildPost({ ...post, scheduled_for: '2031-01-01T10:02:00Z' }, { id: 1, now }).form).scheduled_date, undefined);
  for (const bad of [{ ...post, platforms: ['instagram', 'linkedin'] }, { ...post, platforms: [] }, { ...post, caption: ' ' }, { ...post, media: [{ type: 'video', url: 'http://x.example.test/a.mp4' }] },
    { ...post, media: [] }, { ...post, media: [post.media[0], post.media[0]] }, { ...post, scheduled_for: 'soon' }, null]) assert.throws(() => up.buildPost(bad, { id: 1 }), up.PostError);
});

test('publishing: approved items are sent once each and reported back; a bad one is marked failed and the rest carry on', async () => {
  const calls = []; const finished = [];
  site._setFetch(async (url, o) => {
    if (url.includes('path=agent%2Fapprovals&')) return { ok: true, json: async () => ({ approvals: url.includes('kind=social_post') && url.startsWith('https://b3golf.co.uk/api/booking/?path=') ? [{ id: 1, payload: post }, { id: 2, payload: { ...post, caption: '' } }] : [] }) };
    if (url.endsWith('path=agent%2Fapprovals%2Fresult')) { finished.push(JSON.parse(o.body)); return { ok: true, json: async () => ({}) }; }
    throw new Error('unexpected ' + url);
  });
  up._setFetch(async (url, o) => { calls.push({ url, key: o.headers['Idempotency-Key'], auth: o.headers.Authorization.split(' ')[0] }); return { ok: true, json: async () => ({ request_id: 'r1' }) }; });
  const r = await jobs.publishApproved();
  assert.deepEqual({ sent: r.sent, failed: r.failed }, { sent: 1, failed: 1 });
  assert.deepEqual(calls, [{ url: 'https://api.upload-post.com/api/upload', key: 'b3-approval-1', auth: 'Apikey' }]);
  assert.equal(finished[0].ok, true); assert.equal(finished[0].result.tiktok_draft, true); assert.match(finished[0].result.note, /drafts/);
  assert.deepEqual(finished[1], { id: 2, ok: false, result: { reason: 'The post has no caption.' } });
});

test('numbers: followers today, complete days only from the daily series, reviews when there are any', () => {
  const rows = rowsFrom({ instagram: { followers: 47, reach_timeseries: [{ date: '2031-01-04', value: 42 }, { date: '2031-01-05', value: 9 }, { date: 'x', value: 1 }, { date: '2031-01-03', value: -1 }] },
    facebook: { error: 'not connected' }, tiktok: { followers: 12, reach_timeseries: [{ date: '2031-01-04', value: 1504 }] } }, { success: true, totalReviewCount: 0, averageRating: 0 }, '2031-01-05');
  assert.deepEqual(rows, [{ source: 'instagram', metric: 'followers', day: '2031-01-05', value: 47 }, { source: 'instagram', metric: 'reach_daily', day: '2031-01-04', value: 42 },
    { source: 'tiktok', metric: 'followers', day: '2031-01-05', value: 12 }, { source: 'tiktok', metric: 'video_views', day: '2031-01-04', value: 1504 }, { source: 'reviews', metric: 'count', day: '2031-01-05', value: 0 }]);
  assert.deepEqual(rowsFrom(null, null, '2031-01-05'), []);
});

test('the scheduled routes only answer Vercel', () => {
  assert.equal(allowed({ headers: { authorization: `Bearer ${'c'.repeat(20)}` } }), true);
  assert.equal(allowed({ headers: { authorization: 'Bearer nope' } }), false); assert.equal(allowed({ headers: {} }), false);
});

test('Dropbox: files are sorted into kinds, and a link is made (or reused) in the form Upload-Post can fetch', async () => {
  process.env.DROPBOX_APP_KEY = 'k'; process.env.DROPBOX_APP_SECRET = 's'; process.env.DROPBOX_REFRESH_TOKEN = 'r';
  const dbx = require('../lib/dropbox'); const calls = [];
  dbx._setFetch(async (url, o) => { calls.push(url.replace('https://api.dropboxapi.com/', ''));
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.endsWith('files/list_folder')) return { ok: true, json: async () => ({ has_more: false, entries: [{ '.tag': 'folder', name: 'Photos' }, { '.tag': 'file', name: 'Bay 1.JPG', path_display: '/Photos/Bay 1.JPG', size: 5, server_modified: '2031-01-01T00:00:00Z' }, { '.tag': 'file', name: 'tip.mp4', path_display: '/Video/tip.mp4', size: 9 }, { '.tag': 'file', name: 'plan.md', path_display: '/Plan/plan.md', size: 2 }] }) };
    if (url.endsWith('create_shared_link_with_settings')) return JSON.parse(o.body).path === '/Video/tip.mp4' ? { ok: false, status: 409, json: async () => ({ error_summary: 'shared_link_already_exists/..' }) } : { ok: true, json: async () => ({ url: 'https://www.dropbox.com/scl/fi/abc/Bay-1.JPG?rlkey=x&dl=0' }) };
    if (url.endsWith('list_shared_links')) return { ok: true, json: async () => ({ links: [{ url: 'https://www.dropbox.com/scl/fi/def/tip.mp4?rlkey=y&dl=0' }] }) };
    throw new Error('unexpected ' + url); });
  assert.deepEqual((await dbx.listFiles()).map((f) => [f.path, f.kind]), [['/Photos/Bay 1.JPG', 'photo'], ['/Video/tip.mp4', 'video'], ['/Plan/plan.md', 'note']]);
  assert.equal(await dbx.directLink('/Photos/Bay 1.JPG'), 'https://www.dropbox.com/scl/fi/abc/Bay-1.JPG?rlkey=x&raw=1');
  assert.equal(await dbx.directLink('/Video/tip.mp4'), 'https://www.dropbox.com/scl/fi/def/tip.mp4?rlkey=y&raw=1');
  assert.equal(calls.filter((c) => c === 'oauth2/token').length, 1);     // one sign-in, reused
});
