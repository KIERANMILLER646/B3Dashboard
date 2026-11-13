// The publish and metrics jobs. Each returns a short summary with no secrets and no personal details.
const site = require('./site');
const up = require('./uploadpost');
const { rowsFrom } = require('./metrics');
const { londonDay } = require('./cron');
const { tiktokDirect } = require('./config');

const HOUR = 36e5;
const TOO_LATE_UNSCHEDULED = 48 * HOUR, TOO_LATE_PAST_DUE = 24 * HOUR, STUCK_AFTER = 2 * HOUR;

// Errors that mean Upload-Post, the site or the network is not working right now (a refused key, a limit, an
// outage, a dropped connection), as opposed to something wrong with the post or a bug.
function isOutage(e) {
  if (e instanceof up.PostError) return false;
  if (e.status) return [401, 403, 408, 429].includes(e.status) || e.status >= 500;
  return e.name === 'TimeoutError' || e.name === 'AbortError' || (e instanceof TypeError && /fetch failed/i.test(e.message)) || !!(e.cause && e.cause.code);
}
const when = (t) => { const d = t ? new Date(t) : null; return d && !isNaN(d) ? d : null; };
const fmt = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);

// A post that could not go out in time is not sent late without a fresh decision.
function tooLate(a, now) {
  const due = when(a.payload && a.payload.scheduled_for), approved = when(a.decided_at);
  if (due && now - due > TOO_LATE_PAST_DUE) return `Not sent: it was due ${fmt(due)} and is now over a day late. Nothing was posted. Queue it again if it is still wanted.`;
  if (!due && approved && now - approved > TOO_LATE_UNSCHEDULED) return `Not sent: it was approved ${fmt(approved)} and could not be sent within two days. Nothing was posted. Queue it again if it is still wanted.`;
  return null;
}
// How long an item has been waiting to go: since it was due, or since it was approved.
const waitingSince = (a, now) => { const due = when(a.payload && a.payload.scheduled_for); return due && due < now ? due : when(a.decided_at) || now; };

// The site refuses a second report on the same item (409); that just means an earlier run already reported it.
const report = (id, ok, result) => site.finish(id, ok, result).catch((e) => { if (e.status !== 409) throw e; });

// Publish what has been approved, and report back what really happened on each network. Each run, for each
// approved item: if Upload-Post already has it, read its result (still working: leave it; finished: Done, or
// Failed with the network and reason, including a partial post); if not, send it once it is due. Scheduled
// posts stay in the queue until their time and are not handed over early. One item failing never stops the rest.
async function publishApproved(now = new Date()) {
  const out = { sent: 0, done: 0, failed: 0, checking: 0, scheduled: 0, waiting: 0, stuck: 0, items: [] };
  for (const kind of ['social_post', 'video']) {
    const { approvals = [] } = await site.approved(kind);
    for (const a of approvals) {
      const platforms = [...new Set(Array.isArray(a.payload && a.payload.platforms) ? a.payload.platforms : [])];
      const due = when(a.payload && a.payload.scheduled_for);
      if (due && due - now > 5 * 60e3) { out.scheduled++; continue; }
      try {
        const st = await up.status(a.id);
        if (st) {
          const o = up.outcome(st, platforms);
          if (!o) { out.checking++; out.items.push({ id: a.id, checking: String(st.status || '') }); continue; }
          const tiktok = platforms.includes('tiktok') && o.networks.some((n) => n.platform === 'tiktok' && n.ok) && !tiktokDirect();
          const result = { request_id: up.requestId(a.id), platforms, networks: o.networks, ...(o.partial ? { partial: true } : {}) };
          if (o.ok) await report(a.id, true, { ...result, note: `${o.text}.${tiktok ? ' TikTok: sent to drafts. Open TikTok to publish it.' : ''}` });
          else await report(a.id, false, { ...result, reason: `${o.partial ? 'Partly posted' : 'Not posted'}: ${o.text}.` });
          if (o.ok) out.done++; else out.failed++;
          out.items.push({ id: a.id, ok: o.ok, ...(o.partial ? { partial: true } : {}) });
          continue;
        }
        const late = tooLate(a, now);
        if (late) { await report(a.id, false, { reason: late, too_late: true }); out.failed++; out.items.push({ id: a.id, ok: false, reason: late }); continue; }
        const sent = await up.publish(a.payload, { id: a.id, now });
        out.sent++; out.items.push({ id: a.id, sent: true });
        // The result is looked up by our own request id. If Upload-Post ever answers with a different one, the
        // result could not be found later, so the run is flagged straight away instead of guessing.
        if (sent.request_id !== up.requestId(a.id)) { out.stuck++; out.problem = `Upload-Post did not keep our request id for item ${a.id}; its result cannot be checked.`; }
      } catch (e) {
        // A refused key or an outage is our problem, not the post's: it stays approved for a later run. If it has
        // been waiting over two hours the run is reported as failing, so it shows in Vercel instead of passing quietly.
        if (isOutage(e)) {
          out.waiting++; out.problem = String(e.message).slice(0, 160);
          const since = waitingSince(a, now);
          if (now - since > STUCK_AFTER) { out.stuck++; if (!out.stuck_since || since < new Date(out.stuck_since)) out.stuck_since = since.toISOString(); }
          continue;
        }
        const reason = e instanceof up.PostError ? e.message : `Could not send: ${String(e.message).slice(0, 200)}`;
        await report(a.id, false, { reason }).catch(() => {});
        out.failed++; out.items.push({ id: a.id, ok: false, reason });
      }
    }
  }
  return out;
}

// Collect yesterday's social numbers and the Google review count, and store them on the site.
async function collectMetrics(now = new Date()) {
  const today = londonDay(now); const problems = [];
  const analytics = await up.analytics(['instagram', 'facebook', 'tiktok']).catch((e) => { problems.push(`analytics: ${e.status || 'error'}`); return null; });
  const reviews = await up.reviews().catch((e) => { problems.push(`reviews: ${e.status || 'error'}`); return null; });
  const rows = rowsFrom(analytics, reviews, today);
  const stored = rows.length ? (await site.sendMetrics(rows)).stored : 0;
  return { day: today, rows: rows.length, stored, problems };
}

module.exports = { publishApproved, collectMetrics, isOutage, tooLate };
