// The content agent. Twice a week it looks at what is in the Dropbox folder, the plan notes and what is already
// in the queue, and proposes a few posts. It never posts: every draft goes to the approval queue on the B3 site,
// and only an approved item is sent (by the publish job). It can only use files that are really in the folder.
const crypto = require('crypto');
const { need } = require('./config');
const dbx = require('./dropbox');
const site = require('./site');
const { londonDay } = require('./cron');

const SOURCE = 'content-agent';
const NETWORKS = ['instagram', 'facebook'];             // TikTok joins once its account is connected
const MAX_PENDING = 6, PER_RUN = 3, LOOK_AT = 8, MAX_REVISION = 3, REVISE_PER_RUN = 2;
const model = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

let _fetch = (...a) => fetch(...a);

// What the agent may post from: photos outside the held-back folders. Folders starting with "_" are ignored and
// Phil's folder is reading material, never posted. Junior photos are allowed: the owner confirmed (10 Nov 2026)
// that everything uploaded to this folder has parental consent. Children are never named in a post.
const top = (p) => p.split('/')[1] || '';
const held = (p) => p.split('/').slice(1, -1).some((seg) => seg.startsWith('_') || seg.startsWith('.'));
const usablePhotos = (files) => files.filter((f) => f.kind === 'photo' && !held(f.path) && ['Photos', 'Socials', 'Testimonials'].includes(top(f.path)));
const notesIn = (files) => files.filter((f) => f.kind === 'note' && !held(f.path) && ['Plan', 'Socials'].includes(top(f.path)) && f.size < 200 * 1024);

const keyFor = (paths, caption) => 'content:' + crypto.createHash('sha256').update(paths.length ? [...paths].map((p) => p.toLowerCase()).sort().join('|') : caption).digest('hex').slice(0, 32);

// Checks one draft from the model. Returns a clean draft, or null if it uses anything it was not offered.
function checkDraft(d, allowed, { now = new Date() } = {}) {
  if (!d || typeof d !== 'object') return null;
  const caption = typeof d.caption === 'string' ? d.caption.trim() : '', title = typeof d.title === 'string' ? d.title.trim().slice(0, 120) : '';
  if (!caption || caption.length > 2200 || !title) return null;
  const byLower = new Map(allowed.map((p) => [p.toLowerCase(), p]));
  const paths = [...new Set((Array.isArray(d.media_paths) ? d.media_paths : []).map((p) => byLower.get(String(p).toLowerCase())))];
  if (!paths.length || paths.length > 10 || paths.some((p) => !p)) return null;
  const platforms = [...new Set((Array.isArray(d.platforms) ? d.platforms : NETWORKS).filter((p) => NETWORKS.includes(p)))];
  if (!platforms.length) return null;
  let when = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d.day || '')) { const t = new Date(`${d.day}T18:00:00Z`); if (t - now > 3600e3 && t - now < 21 * 864e5) when = t.toISOString(); }
  return { title, caption, platforms, paths, when, why: typeof d.why === 'string' ? d.why.trim().slice(0, 600) : '' };
}

const RULES = `You plan social media posts for B3 Golf, an indoor golf studio (Trackman simulator bays and coaching) at Iford Golf Centre, Bournemouth.
You draft posts for the owner to approve. Nothing you write is published until he approves it.

Rules:
- UK English. Plain, warm, specific. No hashtag walls (three at most), no emoji strings, no "it's not X, it's Y" lines.
- Give value first: a tip, something to try, something to see. At most a light closing line about booking; no hard sell.
- Use only facts found in the notes you are given. Never invent prices, opening hours, offers, results, quotes or testimonials. If you need a fact you do not have, leave it out.
- Use only media from the list of files, quoting each path exactly. A post is a set of 1 to 10 photos. The list holds only the photos you are shown and the designed sets under Socials/; nothing else can be used.
- Folders under Socials/ that hold a numbered set of images are posts that were already designed. If one has a caption in the notes and is not yet in the queue, propose it as it is, with every image of the set in number order and that caption. Prefer these before making anything new.
- Never name a child or give a child's age, school or club, whatever a file name says.
- Photos you are shown: describe only what is plainly visible. Do not name anyone in a photo unless the file name does.
- Do not repeat anything in the "already in the queue" list.
- Reply by calling the propose_posts tool once with all your drafts. Do not write the drafts as ordinary text.
- Suggest a day for each post (YYYY-MM-DD), spread out, never two on one day, none on a day already taken.`;

// Caps the text sent to the model, cutting the longest text block, so one huge note cannot run up a bill.
const MAX_TEXT = 150000;
function capText(content) {
  const total = content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0);
  if (total <= MAX_TEXT) return content;
  const longest = content.reduce((a, c) => (c.type === 'text' && (!a || c.text.length > a.text.length) ? c : a), null);
  return content.map((c) => (c === longest ? { ...c, text: c.text.slice(0, Math.max(0, c.text.length - (total - MAX_TEXT))) + '\n[cut short]' } : c));
}

// One request to Claude. Returns { posts, stop_reason, usage, reason }: `reason` says why there are no drafts
// when Claude answered without calling the tool (asked once more with a reminder before giving up).
async function askModel(content) {
  const usage = { input_tokens: 0, output_tokens: 0 };
  let stop = null;
  for (const extra of [[], [{ type: 'text', text: 'Reminder: reply only by calling the propose_posts tool, once, with all your drafts.' }]]) {
    const res = await _fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': need('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: model(), max_tokens: 4000, system: RULES, messages: [{ role: 'user', content: capText([...content, ...extra]) }],
        tools: [{ name: 'propose_posts', description: 'Put drafts in the approval queue.', input_schema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', maxItems: PER_RUN, items: { type: 'object', required: ['title', 'caption', 'media_paths', 'day'], properties: {
          title: { type: 'string', description: 'A short label for the queue, not posted.' }, caption: { type: 'string' }, media_paths: { type: 'array', items: { type: 'string' } },
          platforms: { type: 'array', items: { type: 'string', enum: NETWORKS } }, day: { type: 'string', description: 'YYYY-MM-DD' }, why: { type: 'string', description: 'One or two sentences for the owner on why this post, now.' } } } } } } }],
        tool_choice: { type: 'auto' } }) });   // this model does not accept a forced tool, so the rules ask for it
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`Claude: ${res.status} ${(json.error && json.error.type) || ''} ${String((json.error && json.error.message) || '').slice(0, 300)}`.trim()), { status: res.status === 401 ? 503 : 502 });   // Claude's own reason; it never contains the key
    if (json.usage) { usage.input_tokens += json.usage.input_tokens || 0; usage.output_tokens += json.usage.output_tokens || 0; }
    stop = json.stop_reason || null;
    const use = (json.content || []).find((c) => c.type === 'tool_use');
    if (use && use.input && Array.isArray(use.input.posts)) return { posts: use.input.posts, stop_reason: stop, usage };
  }
  return { posts: [], stop_reason: stop, usage, reason: `Claude answered without drafts (stop_reason ${stop || 'unknown'}), twice.` };
}

// The owner's picks: Plan/picks.json lists finished posts (a folder of slides, a caption, a time). Each is queued
// exactly as written, once. No model is involved, so nothing in a pick is reworded. They still need approval.
const PICKS = '/Plan/picks.json';
function readPicks(text, files, { now = new Date() } = {}) {
  let data; try { data = JSON.parse(text); } catch { return { picks: [], problems: ['picks.json is not valid JSON'] }; }
  const picks = [], problems = [];
  for (const p of (Array.isArray(data && data.posts) ? data.posts : [])) {
    const key = typeof p.key === 'string' ? p.key.trim() : '', title = typeof p.title === 'string' ? p.title.trim().slice(0, 120) : '';
    const caption = typeof p.caption === 'string' ? p.caption.trim() : '';
    const folder = '/' + String(p.folder || '').replace(/^\/+|\/+$/g, '') + '/';
    if (!key || !title || !caption || caption.length > 2200 || folder === '//') { problems.push(`${key || '?'}: missing key, title, caption or folder`); continue; }
    if (held(folder + 'x.jpg') || !['Photos', 'Socials', 'Testimonials'].includes(top(folder))) { problems.push(`${key}: that folder is never posted from`); continue; }
    const paths = files.filter((f) => f.kind === 'photo' && f.path.toLowerCase().startsWith(folder.toLowerCase()) && !f.path.slice(folder.length).includes('/'))
      .map((f) => f.path).sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
    if (!paths.length || paths.length > 10) { problems.push(`${key}: ${paths.length} photos in ${folder}`); continue; }
    const platforms = [...new Set((Array.isArray(p.platforms) ? p.platforms : NETWORKS).filter((x) => NETWORKS.includes(x)))];
    let when = null; if (p.when) { const t = new Date(p.when); if (!isNaN(t) && t - now > 10 * 60e3) when = t.toISOString(); }
    picks.push({ key, title, caption, paths, platforms: platforms.length ? platforms : NETWORKS, when });
  }
  return { picks, problems };
}

async function proposePicks(files, now) {
  const out = { proposed: 0, already: 0, problems: [] };
  if (!files.some((f) => f.path.toLowerCase() === PICKS.toLowerCase())) return out;
  const { picks, problems } = readPicks(await dbx.readText(PICKS), files, { now });
  out.problems.push(...problems);
  for (const p of picks) {
    try {
      const media = []; for (const path of p.paths) media.push({ type: 'photo', url: await dbx.directLink(path) });
      const payload = { platforms: p.platforms, caption: p.caption, media, source_paths: p.paths, ...(p.when ? { scheduled_for: p.when } : {}) };
      const r = await site.propose({ kind: 'social_post', title: p.title, summary: "Owner's pick, queued as written.", payload, source: SOURCE, customer_facing: true, dedupe_key: `pick:${p.key}` });
      if (r.created) out.proposed++; else out.already++;
    } catch (e) { out.problems.push(`${p.key}: ${String(e.message).slice(0, 120)}`); }
  }
  return out;
}

// Shows the model a photo: its path, then a small preview. Returns false if Dropbox has no preview for it.
async function show(content, path) {
  try { const b = await dbx.thumbnail(path); content.push({ type: 'text', text: path }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b.toString('base64') } }); return true; }
  catch { return false; }
}
const addUsage = (total, u) => { if (u) { total.input_tokens += u.input_tokens || 0; total.output_tokens += u.output_tokens || 0; } };
const designedIn = (photos) => photos.filter((f) => top(f.path) === 'Socials').map((f) => f.path);

// "Ask for changes": the owner's note goes back to the model with the draft, and the new version replaces the old
// one in the queue (as a revision of the same item, waiting for a decision again). A draft is revised at most twice.
async function revise(a, photos, now, days, usage) {
  const byLower = new Map(photos.map((f) => [f.path.toLowerCase(), f.path]));
  const own = ((a.payload && a.payload.source_paths) || []).map((x) => byLower.get(String(x).toLowerCase())).filter(Boolean);
  const content = [{ type: 'text', text: [
    `Today is ${londonDay(now)}. The owner asked for changes to one of your drafts. Write one new version that does what his note asks, following the rules, and propose just that one post. Keep the same photos unless the note asks otherwise.`,
    `Title: ${a.title}`, `Caption:\n${(a.payload && a.payload.caption) || ''}`, `Photos, in order:\n${own.join('\n') || '(none still in the folder)'}`,
    `Suggested day: ${a.payload && a.payload.scheduled_for ? londonDay(new Date(a.payload.scheduled_for)) : 'none'}`,
    `The owner's note: ${a.decision_note || '(no note)'}`,
    `Designed sets you may use instead:\n${designedIn(photos).join('\n') || '(none)'}`,
    `Days already taken: ${[...days].join(', ') || 'none'}`,
    own.length ? 'The current photos follow, each after its path.' : '' ].join('\n\n') }];
  const seen = []; for (const path of own) if (await show(content, path)) seen.push(path);
  const answer = await askModel(content); addUsage(usage, answer.usage);
  const d = checkDraft(answer.posts[0], [...seen, ...designedIn(photos)], { now });
  if (!d) return { id: a.id, revised: false, reason: answer.reason || 'the new version did not pass the checks' };
  if (d.when && days.has(londonDay(new Date(d.when)))) d.when = null;
  const media = []; for (const path of d.paths) media.push({ type: 'photo', url: await dbx.directLink(path) });
  const payload = { platforms: d.platforms, caption: d.caption, media, source_paths: d.paths, ...(d.when ? { scheduled_for: d.when } : {}) };
  await site.propose({ kind: 'social_post', title: d.title, summary: d.why || undefined, payload, source: SOURCE, customer_facing: true, revises: a.id });
  if (d.when) days.add(londonDay(new Date(d.when)));
  return { id: a.id, revised: true };
}

async function draftPosts(now = new Date()) {
  need('ANTHROPIC_API_KEY');
  const files = await dbx.listFiles('');
  const picked = await proposePicks(files, now);
  const { approvals = [] } = await site.recent();
  const mine = approvals.filter((a) => a.kind === 'social_post');
  const photos = usablePhotos(files);
  const used = new Set(mine.flatMap((a) => (a.payload && a.payload.source_paths) || []).map((p) => String(p).toLowerCase()));
  const days = new Set(mine.map((a) => a.payload && a.payload.scheduled_for).filter(Boolean).map((t) => londonDay(new Date(t))));
  const usage = { input_tokens: 0, output_tokens: 0 };

  // Changes the owner asked for come first. A draft already revised twice is left as it is and no longer counts.
  const revisable = mine.filter((a) => a.status === 'changes' && a.source === SOURCE && (Number(a.revision) || 1) < MAX_REVISION);
  const revisions = [];
  for (const a of revisable.slice(0, REVISE_PER_RUN)) {
    const own = a.payload && a.payload.scheduled_for ? londonDay(new Date(a.payload.scheduled_for)) : null;
    const others = new Set([...days].filter((x) => x !== own));
    let r; try { r = await revise(a, photos, now, others, usage); } catch (e) { r = { id: a.id, revised: false, reason: String(e.message).slice(0, 120) }; }
    revisions.push(r);
    if (r.revised) { days.clear(); for (const x of others) days.add(x); }   // the new version's day replaces the old one
  }
  const base = { picks: picked, ...(revisions.length ? { revisions } : {}) };

  // A run that queued the owner's picks stops there, so it never adds drafts the owner didn't ask for.
  if (picked.proposed) return { ...base, proposed: 0, usage, reason: "Queued the owner's picks only." };
  const waiting = mine.filter((a) => a.status === 'pending').length + revisable.length;
  if (waiting >= MAX_PENDING) return { ...base, proposed: 0, usage, reason: `${waiting} drafts are already waiting for a decision.` };
  if (!photos.length) return { ...base, proposed: 0, usage, reason: 'No usable photos in the Dropbox folder.' };

  const notes = [];
  for (const n of notesIn(files).slice(0, 6)) { try { notes.push(`--- ${n.path} ---\n${await dbx.readText(n.path)}`); } catch { /* a note that cannot be read is skipped */ } }

  // Show the model a few loose photos it has not used yet. It may use only those it was really shown, plus the
  // designed sets under Socials/, so a caption is never written from a file name alone.
  const fresh = photos.filter((f) => top(f.path) === 'Photos' && !used.has(f.path.toLowerCase())).sort(() => Math.random() - 0.5).slice(0, LOOK_AT);
  const previews = []; const seen = [];
  for (const f of fresh) if (await show(previews, f.path)) seen.push(f.path);
  const allowed = [...seen, ...designedIn(photos)];
  const content = [{ type: 'text', text: [
    `Today is ${londonDay(now)}. Propose up to ${Math.min(PER_RUN, MAX_PENDING - waiting)} posts.`,
    `Files you may use (${allowed.length}: the photos shown below and the designed sets under Socials/; * means already used in a post):\n${allowed.map((p) => `${used.has(p.toLowerCase()) ? '* ' : ''}${p}`).join('\n') || '(none)'}`,
    `Already in the queue or posted:\n${mine.slice(0, 60).map((a) => `- [${a.status}] ${a.title}`).join('\n') || '(nothing yet)'}`,
    `Days already taken: ${[...days].join(', ') || 'none'}`,
    `Notes from the Plan and Socials folders:\n${notes.join('\n\n') || '(no notes yet)'}`,
    seen.length ? 'Unused photos follow, each after its path.' : '' ].join('\n\n') }, ...previews];

  const answer = await askModel(content); addUsage(usage, answer.usage);
  const out = { ...base, proposed: 0, skipped: 0, items: [], stop_reason: answer.stop_reason, usage, ...(answer.reason ? { reason: answer.reason } : {}) };
  const allPaths = photos.map((f) => f.path);
  for (const raw of answer.posts.slice(0, PER_RUN)) {
    const d = checkDraft(raw, allowed, { now });
    if (!d) { out.skipped++; out.items.push({ skipped: checkDraft(raw, allPaths, { now }) ? 'uses a photo Claude was not shown' : 'did not pass the checks' }); continue; }
    // The same photos already in the queue (an owner's pick, or an earlier draft) are not queued again.
    if (d.paths.every((p) => used.has(p.toLowerCase()))) { out.skipped++; out.items.push({ skipped: 'already queued' }); continue; }
    if (d.when && days.has(londonDay(new Date(d.when)))) d.when = null;
    try {
      const media = []; for (const p of d.paths) media.push({ type: 'photo', url: await dbx.directLink(p) });
      const payload = { platforms: d.platforms, caption: d.caption, media, source_paths: d.paths, ...(d.when ? { scheduled_for: d.when } : {}) };
      const r = await site.propose({ kind: 'social_post', title: d.title, summary: d.why || undefined, payload, source: SOURCE, customer_facing: true, dedupe_key: keyFor(d.paths, d.caption) });
      if (r.created) { out.proposed++; if (d.when) days.add(londonDay(new Date(d.when))); for (const p of d.paths) used.add(p.toLowerCase()); } else out.skipped++;
      out.items.push({ id: r.approval && r.approval.id, new: !!r.created });
    } catch (e) { out.skipped++; out.items.push({ error: String(e.message).slice(0, 120) }); }
  }
  return out;
}

module.exports = { draftPosts, readPicks, checkDraft, usablePhotos, notesIn, keyFor, capText, _setFetch: (f) => { _fetch = f; } };
