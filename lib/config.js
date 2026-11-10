// Settings come from the Vercel project. Nothing secret is ever logged.
const need = (k) => { const v = process.env[k]; if (!v) throw Object.assign(new Error(`${k} is not set`), { status: 503 }); return v; };
module.exports = {
  need,
  siteBase: () => (process.env.B3_API_BASE || 'https://b3golf.co.uk').replace(/\/$/, ''),
  profile: () => process.env.UPLOAD_POST_PROFILE || 'default',
  facebookPageId: () => process.env.FACEBOOK_PAGE_ID || '',
  tiktokDirect: () => process.env.TIKTOK_MODE === 'direct',
  // Networks this project may post to. Anything else in a request is refused.
  PLATFORMS: ['instagram', 'facebook', 'google_business', 'tiktok'],
};
