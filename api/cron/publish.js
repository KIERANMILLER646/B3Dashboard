const { allowed, send } = require('../../lib/cron');
const jobs = require('../../lib/jobs');
module.exports = async (req, res) => {
  if (!allowed(req)) return send(res, 401, { error: 'Not allowed.' });
  try { return send(res, 200, await jobs.publishApproved()); }
  catch (e) { console.error('publish job failed', e.status || '', e.message); return send(res, e.status === 503 ? 503 : 500, { error: e.status === 503 ? e.message : 'The job failed.' }); }
};
