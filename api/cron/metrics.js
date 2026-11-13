const { allowed, send } = require('../../lib/cron');
const jobs = require('../../lib/jobs');
module.exports = async (req, res) => {
  if (!allowed(req)) return send(res, 401, { error: 'Not allowed.' });
  try {
    const r = await jobs.collectMetrics();
    // Nothing collected and a source refused: the run is reported as failed so a dead feed shows in Vercel.
    if (!r.rows && r.problems.length) { console.error('metrics job: nothing collected', JSON.stringify(r)); return send(res, 502, r); }
    console.log('metrics job', JSON.stringify(r));
    return send(res, 200, r);
  } catch (e) { console.error('metrics job failed', e.status || '', e.message); return send(res, e.status === 503 ? 503 : 500, { error: e.status === 503 ? e.message : 'The job failed.' }); }
};
