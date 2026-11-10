# B3 dashboard: working notes for Claude

Private services behind the B3 Golf dashboard. Separate from the B3 website repo and from anything Iford.

- **Nothing is published, sent or spent without approval.** This project only acts on items a person approved in the queue held by the B3 website (`agent/approvals`). Never add a path that posts without one.
- **Never request, print or log secrets.** Keys are set by the owner in this Vercel project: `DASHBOARD_AGENT_TOKEN`, `UPLOAD_POST_API_KEY`, `CRON_SECRET`.
- **B3 only.** The Upload-Post profile is fixed by `UPLOAD_POST_PROFILE` (the B3 profile's ID is `default`). Never read or post to another profile.
- **TikTok goes to drafts** unless `TIKTOK_MODE=direct` is set by the owner.
- No customer or staff names in anything this project stores or sends: totals only.
- Before pushing: `npm test`. UK English.
