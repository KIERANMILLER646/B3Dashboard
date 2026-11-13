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

test('publishing: an approved item is sent once, with our own request id; a bad one is marked failed and the rest carry on', async () => {
  const calls = []; const finished = [];
  site._setFetch(async (url, o) => {
    if (url.includes('path=agent%2Fapprovals&')) return { ok: true, json: async () => ({ approvals: url.includes('kind=social_post') && url.startsWith('https://b3golf.co.uk/api/booking/?path=') ? [{ id: 1, payload: post }, { id: 2, payload: { ...post, caption: '' } }] : [] }) };
    if (url.endsWith('path=agent%2Fapprovals%2Fresult')) { finished.push(JSON.parse(o.body)); return { ok: true, json: async () => ({}) }; }
    throw new Error('unexpected ' + url);
  });
  up._setFetch(async (url, o) => {
    calls.push({ url, method: o.method, key: o.headers['Idempotency-Key'], req: o.headers['X-Request-Id'], auth: o.headers.Authorization.split(' ')[0], form: o.body ? form(o.body) : null });
    if (url.includes('uploadposts/status')) return { ok: false, status: 404, json: async () => ({ status: 'not_found' }) };
    return { ok: true, json: async () => ({ request_id: 'b3-approval-1' }) };
  });
  const r = await jobs.publishApproved();
  assert.deepEqual({ sent: r.sent, failed: r.failed, done: r.done }, { sent: 1, failed: 1, done: 0 });
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', 'https://api.upload-post.com/api/uploadposts/status?request_id=b3-approval-1'], ['POST', 'https://api.upload-post.com/api/upload'], ['GET', 'https://api.upload-post.com/api/uploadposts/status?request_id=b3-approval-2']]);
  assert.deepEqual([calls[1].key, calls[1].req, calls[1].auth, calls[1].form.request_id], ['b3-approval-1', 'b3-approval-1', 'Apikey', ['b3-approval-1']]);
  assert.deepEqual(finished, [{ id: 2, ok: false, result: { reason: 'The post has no caption.' } }]);   // the sent one is not Done until Upload-Post says so
});

// A tiny queue and Upload-Post for the publish job: `items` are the approved rows, `statusFor(id)` what Upload-Post says.
async function runPublish(items, statusFor, now = new Date('2031-01-10T12:00:00Z')) {
  const finished = [], uploads = [];
  site._setFetch(async (url, o) => {
    if (o.method === 'GET') return { ok: true, json: async () => ({ approvals: url.includes('kind=social_post') ? items : [] }) };
    finished.push(JSON.parse(o.body)); return { ok: true, json: async () => ({}) };
  });
  up._setFetch(async (url, o) => {
    if (url.includes('uploadposts/status')) { const s = await statusFor(Number(url.split('b3-approval-')[1])); return s ? { ok: s.httpStatus ? false : true, status: s.httpStatus || 200, json: async () => s } : { ok: false, status: 404, json: async () => ({ status: 'not_found' }) }; }
    uploads.push(url); return { ok: true, json: async () => ({}) };
  });
  return { r: await jobs.publishApproved(now), finished, uploads };
}
const ig = { platforms: ['instagram', 'facebook'], caption: 'Bay 3 at dusk.', media: [{ type: 'photo', url: 'https://x.example.test/1.jpg' }] };

test("publishing: Done only when every network posted; a failed or skipped network makes it Failed, with what did post", async () => {
  const st = {
    1: { status: 'completed', results: [{ platform: 'instagram', success: true, post_url: 'https://instagram.example.test/p/1' }, { platform: 'facebook', success: true }] },
    2: { status: 'completed', results: [{ platform: 'instagram', success: false, message: 'Media URL could not be fetched' }, { platform: 'facebook', success: true }] },
    3: { status: 'completed', results: [{ platform: 'instagram', success: true }, { platform: 'facebook', success: true, skipped: true, skip_reason: 'profile_platform_not_configured' }] },
    4: { status: 'failed', message: 'Upload appears to have failed (no activity for over 1 hour)', results: [] },
    5: { status: 'in_progress', results: [{ platform: 'instagram', success: true, message: 'Queued' }] },
  };
  const { r, finished, uploads } = await runPublish([1, 2, 3, 4, 5].map((id) => ({ id, payload: ig })), (id) => st[id]);
  assert.deepEqual([r.done, r.failed, r.checking, r.sent, uploads.length], [1, 3, 1, 0, 0]);
  const by = Object.fromEntries(finished.map((f) => [f.id, f]));
  assert.equal(by[1].ok, true); assert.equal(by[1].result.note, 'Instagram and Facebook posted.'); assert.equal(by[1].result.networks[0].post_url, 'https://instagram.example.test/p/1');
  assert.deepEqual([by[2].ok, by[2].result.partial, by[2].result.reason], [false, true, 'Partly posted: Facebook posted; Instagram failed: Media URL could not be fetched.']);
  assert.deepEqual([by[3].ok, by[3].result.reason], [false, 'Partly posted: Instagram posted; Facebook failed: no account connected to the B3 profile.']);
  assert.match(by[4].result.reason, /^Not posted: Instagram failed: Upload appears to have failed/);
  assert.equal(by[5], undefined);                                                       // still working: left approved, checked next run
});

test('publishing: a scheduled post waits in the queue until it is due, then goes out once', async () => {
  const now = new Date('2031-01-10T12:00:00Z');
  const later = await runPublish([{ id: 1, payload: { ...ig, scheduled_for: '2031-01-11T18:00:00Z' }, decided_at: '2031-01-09T10:00:00Z' }], () => { throw new Error('should not ask'); }, now);
  assert.deepEqual([later.r.scheduled, later.uploads.length, later.finished.length], [1, 0, 0]);
  const due = await runPublish([{ id: 1, payload: { ...ig, scheduled_for: '2031-01-10T12:00:00Z' }, decided_at: '2031-01-09T10:00:00Z' }], () => null, now);
  assert.deepEqual([due.r.sent, due.uploads, due.finished.length], [1, ['https://api.upload-post.com/api/upload_photos'], 0]);
});

test('publishing: a post that could not go out in time is failed, not sent late; a long outage is reported, a blip is not', async () => {
  const now = new Date('2031-01-10T12:00:00Z');
  const old = await runPublish([{ id: 1, payload: ig, decided_at: '2031-01-07T09:00:00Z' }, { id: 2, payload: { ...ig, scheduled_for: '2031-01-08T18:00:00Z' }, decided_at: '2031-01-05T09:00:00Z' }, { id: 3, payload: ig, decided_at: '2031-01-10T09:00:00Z' }], () => null, now);
  assert.deepEqual([old.r.failed, old.r.sent, old.uploads.length], [2, 1, 1]);
  assert.ok(old.finished.every((f) => f.ok === false && f.result.too_late && /Nothing was posted/.test(f.result.reason)));
  const down = { httpStatus: 503, message: 'Service unavailable' };
  const blip = await runPublish([{ id: 1, payload: ig, decided_at: '2031-01-10T11:50:00Z' }], () => down, now);
  assert.deepEqual([blip.r.waiting, blip.r.stuck, blip.finished.length], [1, 0, 0]);
  const stuck = await runPublish([{ id: 1, payload: ig, decided_at: '2031-01-10T08:00:00Z' }], () => down, now);
  assert.deepEqual([stuck.r.waiting, stuck.r.stuck, stuck.r.stuck_since, stuck.finished.length], [1, 1, '2031-01-10T08:00:00.000Z', 0]);
  // Only a dropped connection counts as an outage; any other error without a status fails the item with its reason.
  assert.equal(jobs.isOutage(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), true);
  assert.equal(jobs.isOutage(new TypeError('Cannot read properties of undefined')), false);
  const bug = await runPublish([{ id: 1, payload: ig, decided_at: '2031-01-10T11:50:00Z' }], () => { throw new TypeError('Cannot read properties of undefined'); }, now);
  assert.deepEqual([bug.r.failed, bug.finished[0].ok], [1, false]); assert.match(bug.finished[0].result.reason, /^Could not send: Cannot read/);
});

test('publishing: the TikTok drafts note is kept once TikTok has the post', async () => {
  const { finished } = await runPublish([{ id: 4, payload: { ...post, platforms: ['tiktok'] } }], () => ({ status: 'completed', results: [{ platform: 'tiktok', status: 'completed', success: true }] }));
  assert.equal(finished[0].ok, true); assert.match(finished[0].result.note, /^TikTok posted\. TikTok: sent to drafts/);
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

const agent = require('../lib/agent');
const dbx = require('../lib/dropbox');
test('content agent: only offered, non-held photos can be used, and drafts go to the queue, never straight out', async () => {
  const f = (path, kind = 'photo', size = 10) => ({ path, name: path.split('/').pop(), kind, size });
  const files = [f('/Photos/a.jpg'), f('/Photos/Juniors/k.jpg'), f('/Photos/kids-golf.jpg'), f('/_Duplicates - safe to delete/a (1).jpg'), f('/Phil/guide.pdf', 'document'),
    f('/Socials/Set/p01-launch/p01-launch-1.jpg'), f('/Socials/Set/p06-juniors/p06-juniors-1.jpg'), f('/Brand/logo.png'), f('/Video/Lessons/x.mp4', 'video'), f('/Socials/Set/captions.md', 'note'), f('/Phil/notes.md', 'note')];
  assert.deepEqual(agent.usablePhotos(files).map((x) => x.path), ['/Photos/a.jpg', '/Photos/Juniors/k.jpg', '/Photos/kids-golf.jpg', '/Socials/Set/p01-launch/p01-launch-1.jpg', '/Socials/Set/p06-juniors/p06-juniors-1.jpg']);
  assert.deepEqual(agent.notesIn(files).map((x) => x.path), ['/Socials/Set/captions.md']);
  const allowed = ['/Photos/a.jpg', '/Photos/b.jpg']; const now = new Date('2031-01-01T10:00:00Z');
  const ok = agent.checkDraft({ title: 'T', caption: 'C', media_paths: ['/photos/A.jpg'], platforms: ['instagram', 'tiktok'], day: '2031-01-03' }, allowed, { now });
  assert.deepEqual([ok.paths, ok.platforms, ok.when], [['/Photos/a.jpg'], ['instagram'], '2031-01-03T18:00:00.000Z']);
  assert.equal(agent.checkDraft({ title: 'T', caption: 'C', media_paths: ['/Photos/a.jpg'], day: '2030-12-01' }, allowed, { now }).when, null);
  for (const bad of [{ title: 'T', caption: 'C', media_paths: ['/Phil/guide.jpg'] }, { title: 'T', caption: 'C', media_paths: [] }, { title: '', caption: 'C', media_paths: allowed }, { title: 'T', caption: 'C', media_paths: allowed, platforms: ['tiktok'] }, null]) assert.equal(agent.checkDraft(bad, allowed, { now }), null);
  assert.equal(agent.keyFor(['/b', '/A'], 'x'), agent.keyFor(['/a', '/B'], 'y'));

  process.env.ANTHROPIC_API_KEY = 'a'.repeat(20); process.env.DROPBOX_APP_KEY = 'k'; process.env.DROPBOX_APP_SECRET = 's'; process.env.DROPBOX_REFRESH_TOKEN = 'r';
  const proposed = []; let asked = null;
  site._setFetch(async (url, o) => {
    if (o.method === 'GET') return { ok: true, json: async () => ({ approvals: [{ kind: 'social_post', status: 'done', title: 'Old', payload: { source_paths: ['/Photos/old.jpg'], scheduled_for: '2031-01-03T18:00:00Z' } }] }) };
    proposed.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ created: true, approval: { id: proposed.length } }) };
  });
  dbx._setFetch(async (url, o) => {
    if (url.includes('oauth2/token')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    if (url.endsWith('files/list_folder')) return { ok: true, json: async () => ({ has_more: false, entries: ['/Photos/a.jpg', '/Photos/old.jpg', '/_Duplicates/k.jpg'].map((p) => ({ '.tag': 'file', path_display: p, name: p.split('/').pop(), size: 5 })) }) };
    if (url.includes('get_thumbnail_v2')) return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    if (url.endsWith('create_shared_link_with_settings')) return { ok: true, json: async () => ({ url: 'https://www.dropbox.com/scl/fi/x/a.jpg?rlkey=1&dl=0' }) };
    throw new Error('unexpected ' + url);
  });
  agent._setFetch(async (url, o) => { asked = JSON.parse(o.body); return { ok: true, json: async () => ({ content: [{ type: 'tool_use', input: { posts: [
    { title: 'Bay photo', caption: 'A look inside.', media_paths: ['/Photos/a.jpg'], day: '2031-01-03', why: 'New.' }, { title: 'Sneaky', caption: 'x', media_paths: ['/_Duplicates/k.jpg'], day: '2031-01-05' }] } }] }) }; });
  const r = await agent.draftPosts(now);
  assert.deepEqual([r.proposed, r.skipped], [1, 1]);
  assert.equal(asked.messages[0].content.filter((c) => c.type === 'image').length, 1);          // only the unused, non-held photo is shown
  assert.ok(!JSON.stringify(asked.messages).includes('_Duplicates'));
  const p = proposed[0];
  assert.deepEqual([p.kind, p.source, p.customer_facing, p.payload.platforms, p.payload.source_paths], ['social_post', 'content-agent', true, ['instagram', 'facebook'], ['/Photos/a.jpg']]);
  assert.equal(p.payload.media[0].url, 'https://www.dropbox.com/scl/fi/x/a.jpg?rlkey=1&raw=1'); assert.equal(p.payload.scheduled_for, undefined);   // that day was taken
  assert.doesNotThrow(() => up.buildPost(p.payload, { id: 1, now }));
});

test("owner's picks: each listed folder becomes one post with its slides in order, held folders refused", () => {
  const f = (path) => ({ path, name: path.split('/').pop(), kind: path.endsWith('.json') ? 'other' : 'photo', size: 5 });
  const files = ['/Socials/S/p11-putting/p11-putting-10.jpg', '/Socials/S/p11-putting/p11-putting-2.jpg', '/Socials/S/p11-putting/p11-putting-1.jpg', '/Socials/S/p11-putting/sub/x.jpg', '/_Duplicates/a.jpg', '/Plan/picks.json'].map(f);
  const now = new Date('2031-01-01T10:00:00Z');
  const text = JSON.stringify({ posts: [
    { key: 'p11', title: 'Putting', caption: 'Four tasks.', folder: 'Socials/S/p11-putting', when: '2031-01-02T12:30:00Z', platforms: ['instagram', 'facebook', 'linkedin'] },
    { key: 'dup', title: 'No', caption: 'x', folder: '_Duplicates' }, { key: 'phil', title: 'No', caption: 'x', folder: 'Phil' }, { key: 'none', title: 'No', caption: 'x', folder: 'Socials/S/missing' }, { key: 'old', title: 'Past', caption: 'x', folder: 'Socials/S/p11-putting', when: '2030-01-01T00:00:00Z' }] });
  const { picks, problems } = agent.readPicks(text, files, { now });
  assert.deepEqual(picks[0].paths, ['/Socials/S/p11-putting/p11-putting-1.jpg', '/Socials/S/p11-putting/p11-putting-2.jpg', '/Socials/S/p11-putting/p11-putting-10.jpg']);
  assert.deepEqual([picks[0].platforms, picks[0].when, picks.length, problems.length], [['instagram', 'facebook'], '2031-01-02T12:30:00.000Z', 2, 3]);
  assert.equal(picks[1].when, null);
  assert.deepEqual(agent.readPicks('nope', files).problems, ['picks.json is not valid JSON']);
});

test('publishing: a refused key leaves approved posts waiting instead of marking them failed', async () => {
  const { r, finished, uploads } = await runPublish([{ id: 5, payload: post }], () => ({ httpStatus: 401, message: 'Invalid API key' }));
  assert.deepEqual([r.sent, r.failed, r.waiting, finished.length, uploads.length], [0, 0, 1, 0, 0]);
});

// A Dropbox folder, a queue and a Claude for the content agent. `replies` are Claude's answers, in order.
async function agentRun({ approvals = [], paths = ['/Photos/a.jpg'], replies, now = new Date('2031-01-01T10:00:00Z'), thumbsFail = [] }) {
  process.env.ANTHROPIC_API_KEY = 'a'.repeat(20); process.env.DROPBOX_APP_KEY = 'k'; process.env.DROPBOX_APP_SECRET = 's'; process.env.DROPBOX_REFRESH_TOKEN = 'r';
  const proposed = [], asked = [];
  site._setFetch(async (url, o) => {
    if (o.method === 'GET') return { ok: true, json: async () => ({ approvals }) };
    proposed.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ created: true, approval: { id: 100 + proposed.length } }) };
  });
  dbx._setFetch(async (url, o) => {
    if (url.includes('oauth2/token')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    if (url.endsWith('files/list_folder')) return { ok: true, json: async () => ({ has_more: false, entries: paths.map((p) => ({ '.tag': 'file', path_display: p, name: p.split('/').pop(), size: 5 })) }) };
    if (url.includes('get_thumbnail_v2')) { const p = JSON.parse(o.headers['Dropbox-API-Arg']).resource.path; return thumbsFail.includes(p) ? { ok: false, status: 409 } : { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; }
    if (url.endsWith('create_shared_link_with_settings')) return { ok: true, json: async () => ({ url: 'https://www.dropbox.com/scl/fi/x/a.jpg?rlkey=1&dl=0' }) };
    throw new Error('unexpected ' + url);
  });
  const queue = [...replies];
  agent._setFetch(async (url, o) => { asked.push(JSON.parse(o.body)); const r = queue.shift(); return { ok: true, json: async () => r }; });
  return { r: await agent.draftPosts(now), proposed, asked };
}
const tool = (posts, extra = {}) => ({ content: [{ type: 'tool_use', input: { posts } }], stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 200 }, ...extra });

test('content agent: a reply with no drafts is asked again once, then reported with its reason; token use is recorded', async () => {
  const text = { content: [{ type: 'text', text: 'Here are some ideas...' }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 50 } };
  const twice = await agentRun({ replies: [text, { ...text, stop_reason: 'max_tokens' }] });
  assert.equal(twice.asked.length, 2); assert.match(JSON.stringify(twice.asked[1].messages), /Reminder: reply only by calling/);
  assert.deepEqual([twice.r.proposed, twice.r.reason, twice.r.usage], [0, 'Claude answered without drafts (stop_reason max_tokens), twice.', { input_tokens: 1800, output_tokens: 100 }]);
  const second = await agentRun({ replies: [text, tool([{ title: 'Bay', caption: 'A look inside.', media_paths: ['/Photos/a.jpg'], day: '2031-01-03' }])] });
  assert.deepEqual([second.r.proposed, second.r.reason, second.r.usage.input_tokens], [1, undefined, 1900]);
  const big = agent.capText([{ type: 'text', text: 'x'.repeat(200000) }, { type: 'text', text: 'y' }]);
  assert.ok(big[0].text.length < 150020 && big[0].text.endsWith('[cut short]')); assert.equal(big[1].text, 'y');
});
