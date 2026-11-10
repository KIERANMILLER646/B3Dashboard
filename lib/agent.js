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
const MAX_PENDING = 6, PER_RUN = 3, LOOK_AT = 8;
const model = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

let _fetch = (...a) => fetch(...a);

// What the agent may post from: photos outside the held-back folders. Folders starting with "_" are ignored,
// anything marked junior waits for parental consent, and Phil's folder is reading material, never posted.
const top = (p) => p.split('/')[1] || '';
const held = (p) => p.split('/').slice(1, -1).some((seg) => seg.startsWith('_') || seg.startsWith('.')) || /junior|kids/i.test(p);
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
- Use only media from the list of files, quoting each path exactly. A post is a set of 1 to 10 photos.
- Folders under Socials/ that hold a numbered set of images are posts that were already designed. If one has a caption in the notes and is not yet in the queue, propose it as it is, with every image of the set in number order and that caption. Prefer these before making anything new.
- Photos you are shown: describe only what is plainly visible. Do not name anyone in a photo unless the file name does.
- Do not repeat anything in the "already in the queue" list.
- Reply by calling the propose_posts tool once with all your drafts. Do not write the drafts as ordinary text.
- Suggest a day for each post (YYYY-MM-DD), spread out, never two on one day, none on a day already taken.`;

async function askModel(content) {
  const res = await _fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'x-api-key': need('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: model(), max_tokens: 4000, system: RULES, messages: [{ role: 'user', content }],
      tools: [{ name: 'propose_posts', description: 'Put drafts in the approval queue.', input_schema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', maxItems: PER_RUN, items: { type: 'object', required: ['title', 'caption', 'media_paths', 'day'], properties: {
        title: { type: 'string', description: 'A short label for the queue, not posted.' }, caption: { type: 'string' }, media_paths: { type: 'array', items: { type: 'string' } },
        platforms: { type: 'array', items: { type: 'string', enum: NETWORKS } }, day: { type: 'string', description: 'YYYY-MM-DD' }, why: { type: 'string', description: 'One or two sentences for the owner on why this post, now.' } } } } } } }],
      tool_choice: { type: 'auto' } }) });   // this model does not accept a forced tool, so the rules ask for it
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Claude: ${res.status} ${(json.error && json.error.type) || ''} ${String((json.error && json.error.message) || '').slice(0, 300)}`.trim()), { status: res.status === 401 ? 503 : 502 });   // Claude's own reason; it never contains the key
  const use = (json.content || []).find((c) => c.type === 'tool_use');
  return (use && use.input && Array.isArray(use.input.posts)) ? use.input.posts : [];
}

async function draftPosts(now = new Date()) {
  need('ANTHROPIC_API_KEY');
  const { approvals = [], counts = {} } = await site.recent();
  const mine = approvals.filter((a) => a.kind === 'social_post');
  const waiting = mine.filter((a) => a.status === 'pending' || a.status === 'changes').length;
  if (waiting >= MAX_PENDING) return { proposed: 0, reason: `${waiting} drafts are already waiting for a decision.` };

  const files = await dbx.listFiles('');
  const photos = usablePhotos(files); const allowed = photos.map((f) => f.path);
  if (!photos.length) return { proposed: 0, reason: 'No usable photos in the Dropbox folder.' };
  const used = new Set(mine.flatMap((a) => (a.payload && a.payload.source_paths) || []).map((p) => String(p).toLowerCase()));
  const taken = mine.map((a) => a.payload && a.payload.scheduled_for).filter(Boolean).map((t) => londonDay(new Date(t)));

  const notes = [];
  for (const n of notesIn(files).slice(0, 6)) { try { notes.push(`--- ${n.path} ---\n${await dbx.readText(n.path)}`); } catch { /* a note that cannot be read is skipped */ } }

  // Show the model a few loose photos it has not used yet, so captions match what is in the picture.
  const fresh = photos.filter((f) => top(f.path) === 'Photos' && !used.has(f.path.toLowerCase())).sort(() => Math.random() - 0.5).slice(0, LOOK_AT);
  const content = [{ type: 'text', text: [
    `Today is ${londonDay(now)}. Propose up to ${Math.min(PER_RUN, MAX_PENDING - waiting)} posts.`,
    `Files you may use (${photos.length}; * means already used in a post):\n${photos.map((f) => `${used.has(f.path.toLowerCase()) ? '* ' : ''}${f.path}`).join('\n')}`,
    `Already in the queue or posted:\n${mine.slice(0, 60).map((a) => `- [${a.status}] ${a.title}`).join('\n') || '(nothing yet)'}`,
    `Days already taken: ${[...new Set(taken)].join(', ') || 'none'}`,
    `Notes from the Plan and Socials folders:\n${notes.join('\n\n') || '(no notes yet)'}`,
    fresh.length ? 'Unused photos follow, each after its path.' : '' ].join('\n\n') }];
  for (const f of fresh) { try { const b = await dbx.thumbnail(f.path); content.push({ type: 'text', text: f.path }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b.toString('base64') } }); } catch { /* a photo with no preview is still in the list */ } }

  const out = { proposed: 0, skipped: 0, items: [] }; const days = new Set(taken);
  for (const raw of (await askModel(content)).slice(0, PER_RUN)) {
    const d = checkDraft(raw, allowed, { now });
    if (!d) { out.skipped++; continue; }
    if (d.when && days.has(londonDay(new Date(d.when)))) d.when = null;
    try {
      const media = []; for (const p of d.paths) media.push({ type: 'photo', url: await dbx.directLink(p) });
      const payload = { platforms: d.platforms, caption: d.caption, media, source_paths: d.paths, ...(d.when ? { scheduled_for: d.when } : {}) };
      const r = await site.propose({ kind: 'social_post', title: d.title, summary: d.why || undefined, payload, source: SOURCE, customer_facing: true, dedupe_key: keyFor(d.paths, d.caption) });
      if (r.created) { out.proposed++; if (d.when) days.add(londonDay(new Date(d.when))); } else out.skipped++;
      out.items.push({ id: r.approval && r.approval.id, new: !!r.created });
    } catch (e) { out.skipped++; out.items.push({ error: String(e.message).slice(0, 120) }); }
  }
  return out;
}

module.exports = { draftPosts, checkDraft, usablePhotos, notesIn, keyFor, _setFetch: (f) => { _fetch = f; } };
