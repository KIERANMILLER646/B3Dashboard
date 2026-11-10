// Turns Upload-Post's analytics into the daily rows the B3 site stores. Pure.
// Only complete days are sent: today's figures are still moving.
const SERIES = { instagram: ['instagram', 'reach_daily'], facebook: ['facebook', 'reach_daily'], tiktok: ['tiktok', 'video_views'] };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function rowsFrom(analytics, reviews, today) {
  const rows = [];
  for (const [platform, [source, metric]] of Object.entries(SERIES)) {
    const a = analytics && analytics[platform];
    if (!a || typeof a !== 'object' || a.error) continue;
    const followers = num(a.followers);
    if (followers !== null) rows.push({ source, metric: 'followers', day: today, value: followers });
    for (const p of Array.isArray(a.reach_timeseries) ? a.reach_timeseries : []) {
      const v = num(p && p.value);
      if (v !== null && typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.date < today) rows.push({ source, metric, day: p.date, value: v });
    }
  }
  if (reviews && reviews.success !== false) {
    const count = num(reviews.totalReviewCount), rating = num(reviews.averageRating);
    if (count !== null) rows.push({ source: 'reviews', metric: 'count', day: today, value: count });
    if (rating !== null && count) rows.push({ source: 'reviews', metric: 'rating', day: today, value: rating });
  }
  return rows;
}
module.exports = { rowsFrom };
