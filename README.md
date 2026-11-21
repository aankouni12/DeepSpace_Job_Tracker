# applytrack

A job application tracker built on [DeepSpace](https://docs.deep.space). It reads your Gmail (read-only), uses AI to sort job-related emails into a live board (Applied, Interview, Offer, Rejected) with an email timeline per application. An assistant answers questions about your search and can propose a status change, which only happens when you click Confirm.

**Live:** https://applytrack.app.space. Use **Try with demo data** on the board to try it without connecting Gmail.

![The applytrack board with demo data](docs/board.png)

## DeepSpace features used

- **Platform auth** for sign-in. No custom auth or sessions.
- **Google integration** (`google/gmail-inbox`, user-billed, read-only) for Gmail.
- **RecordRoom collections** (`applications`, `emails`, `syncState`), with per-user RBAC: every row is readable only by its owner, admins included. Live sync over WebSocket drives the board.
- **Server actions** for `sync` (Gmail or demo, rate-limited to once per 10 minutes) and `deleteMyData`.
- **Owner-billed AI** for classification and for the assistant (chat panel plus three read-only tools), with daily message caps.
- **Static prerendered landing page** with SEO, and `npx deepspace secrets` for secrets.

## Deliberately not used

- **Jobs (`AppJobRoom`) and cron.** The job queue is app-wide, and job payloads reach every watcher, so email content could leak between users. Sync is a user-triggered server action instead, plus sync on open after 24 hours.
- **Gmail send/modify scopes.** The app only reads.
- **Collaboration, messaging, presence, payments.** Out of scope for a single-user tracker.

## Run locally

```sh
npm install
npx deepspace dev start              # Vite + worker on http://localhost:5173
npx vitest run                       # unit tests (on Windows, run from an uppercase C:\ path)
npx deepspace test run all --port 5180   # Playwright; Google OAuth is mocked with page.route
```

## More

- [ARCHITECTURE.md](ARCHITECTURE.md): components, data model, data flow, security decisions.
- [AGENT_LOG.md](AGENT_LOG.md): how it was built, task by task, including what was changed or rejected.
