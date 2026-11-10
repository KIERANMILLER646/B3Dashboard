// The two scheduled jobs. Each returns a short summary with no secrets and no personal details.
const site = require('./site');
const up = require('./uploadpost');
const { rowsFrom } = require('./metrics');
const { londonDay } = require('./cron');

// Publish what has been approved. One item failing never stops the rest, and a failed item is reported
// back as failed so it shows in the queue instead of being retried for ever.
async function publishApproved() {
  const out = { sent: 0, failed: 0, items: [] };
  for (const kind of ['social_post', 'video']) {
    const { approvals = [] } = await site.approved(kind);
    for (const a of approvals) {
      try {
        const r = await up.publish(a.payload, { id: a.id });
        await site.finish(a.id, true, { ...r, note: r.tiktok_draft ? 'TikTok: sent to drafts. Open TikTok to publish it.' : undefined });
        out.sent++; out.items.push({ id: a.id, ok: true });
      } catch (e) {
        // A refused key or an outage at Upload-Post is our problem, not the post's: leave it approved so it goes on a later run.
        if (!(e instanceof up.PostError) && (e.status === 401 || e.status === 403 || e.status === 429 || e.status >= 500 || !e.status)) { out.waiting = (out.waiting || 0) + 1; out.problem = String(e.message).slice(0, 160); continue; }
        const reason = e instanceof up.PostError ? e.message : `Could not send: ${String(e.message).slice(0, 200)}`;
        await site.finish(a.id, false, { reason }).catch(() => {});
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

module.exports = { publishApproved, collectMetrics };
