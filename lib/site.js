// The B3 website's agent routes: the approval queue and the daily-numbers store.
const { need, siteBase } = require('./config');

let _fetch = (...a) => fetch(...a);
async function call(method, path, body) {
  // The site serves its API at /api/booking/ with the route in ?path= (a path-style address is redirected, then not found).
  const [route, query] = path.split('?');
  const q = new URLSearchParams({ path: route, ...Object.fromEntries(new URLSearchParams(query || '')) });
  const res = await _fetch(`${siteBase()}/api/booking/?${q}`, { method,
    headers: { Authorization: `Bearer ${need('DASHBOARD_AGENT_TOKEN')}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`B3 site ${path}: ${res.status} ${json.error || ''}`.trim()), { status: res.status });
  return json;
}
module.exports = {
  approved: (kind) => call('GET', `agent/approvals?status=approved${kind ? `&kind=${kind}` : ''}`),
  propose: (input) => call('POST', 'agent/approvals', input),
  recent: () => call('GET', 'agent/approvals?status=pending,approved,changes,done,failed,declined'),
  finish: (id, ok, result) => call('POST', 'agent/approvals/result', { id, ok, result }),
  sendMetrics: (rows) => call('POST', 'agent/metrics', { rows }),
  _setFetch: (f) => { _fetch = f; },
};
