const { allowed, send } = require('../../lib/cron');
const jobs = require('../../lib/jobs');
module.exports = async (req, res) => {
  if (!allowed(req)) return send(res, 401, { error: 'Not allowed.' });
  try {
    const r = await jobs.publishApproved();
    // Approved posts that have not gone out for over two hours because Upload-Post or the site is not answering:
    // the run is reported as failed (503) so it stands out in Vercel, every run, until it is put right.
    if (r.stuck) { console.error('publish job: approved posts are stuck', JSON.stringify(r)); return send(res, 503, r); }
    if (r.sent || r.done || r.failed || r.waiting) console.log('publish job', JSON.stringify(r));
    return send(res, 200, r);
  } catch (e) { console.error('publish job failed', e.status || '', e.message); return send(res, e.status === 503 ? 503 : 500, { error: e.status === 503 ? e.message : 'The job failed.' }); }
};
