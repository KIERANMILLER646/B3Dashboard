const { allowed, send } = require('../../lib/cron');
const agent = require('../../lib/agent');
module.exports = async (req, res) => {
  if (!allowed(req)) return send(res, 401, { error: 'Not allowed.' });
  try { const r = await agent.draftPosts(); console.log('content job', JSON.stringify(r)); return send(res, 200, r); }
  catch (e) { console.error('content job failed', e.status || '', e.message); return send(res, e.status === 503 ? 503 : 500, { error: e.status === 503 ? e.message : 'The job failed.' }); }
};
