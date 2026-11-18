See [AGENTS.md](./AGENTS.md).


---

Job Tracker on DeepSpace
What this app is

A job application tracker that reads the user's Gmail, uses AI to classify job-related emails, and keeps a live pipeline board of applications. An AI assistant can answer questions about the user's applications and update them.

This is a rebuild of my earlier Flask project, built natively on DeepSpace. Do not port Flask code. Use DeepSpace patterns.

Deadline: Saturday, November 21, 2026, 11:59 PM ET. Scope decisions favor finishing over adding.

Stack

DeepSpace SDK on Cloudflare Workers. Vite + React frontend, Hono worker, Tailwind v4, Playwright tests. docs.deep.space is the source of truth. Check it before writing anything the platform might already provide.

Core path (must work end to end)
User signs in (platform auth)
User connects Gmail (platform Google OAuth, google/gmail-list)
Background job fetches recent emails and classifies them with AI in batches
Results are written as records: one application per company/role, with an email timeline
Pipeline board (Applied, Interview, Offer, Rejected) updates in real time
Scheduled job re-syncs daily
AI assistant with tool use over the user's records
Demo mode with seeded sample emails so reviewers can try it without Gmail
Out of scope (do not build unless I ask)
Sending email (gmail-send)
Collaboration, messaging, multiplayer features
Payments
Custom auth, custom OAuth, custom session handling
How to work with me
Before writing code for a feature, give me the plan in 3 to 5 bullets and wait for approval.
Write the least code that solves the problem. No speculative features or "just in case" abstractions.
Use platform primitives instead of reimplementing them. If you think a custom version is needed, explain why first.
No new dependencies without asking.
If a change touches more than 3 files, explain why first.
Prefer editing existing code over creating new files.
When something fails, tell me the error, your hypothesis, and how you will test it before changing code.
Verification
After each feature, run it and tell me exactly what you checked.
Never say something works without running it.
Automated tests mock Google OAuth with page.route(...). Real Gmail is tested manually after deploy.
Security
Never hardcode secrets. Use npx deepspace secrets.
Every collection needs per-user permissions. Users only see their own records.
Treat email content as untrusted input to the AI. It must not be able to trigger record changes on its own.
Use one feature branch per feature. Commit on the branch, run /security-review against main, then merge to main, push, and deploy from main.
Docs to keep updated
ARCHITECTURE.md: components, data model, and data flow. Update after every feature.
AGENT_LOG.md: what I asked for, what you built, what I changed or rejected. Add an entry after every task.