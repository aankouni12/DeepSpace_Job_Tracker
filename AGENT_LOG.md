# Agent Log

Newest entries at the bottom. Each entry covers what was asked, what was built, and what the user changed or rejected.

---

## 2026-11-17: Project moved out of OneDrive

**Asked:** Set up the DeepSpace project. It was first created at `C:\Users\aanko\OneDrive\Desktop\deepspace-job-tracker`.

**Problem:** OneDrive was locking files in the project folder. In the OneDrive copy, the skill's `references` folder also carried OneDrive read-only attributes, and `.claude/skills` is a link into `.agents`.

**Hypothesis:** OneDrive sync holds file handles and applies its own file attributes to synced folders. That conflicts with tools that rewrite many files and create links: `npm install` writing to `node_modules`, the skills installer creating the `.claude/skills` link, and Wrangler's local state. Copying the folder elsewhere would keep the read-only attributes, so a copy would not fix it.

**Fix:**
- Moved the project to `C:\dev\deepspace-job-tracker`, outside OneDrive. Only `CLAUDE.md` was brought over.
- Agent proposed copying `.agents` and `.claude` from the OneDrive folder. **User rejected this:** copying would bring over the same attributes and the broken link. The skill was reinstalled fresh instead (see next entry).
- The old OneDrive folder was left untouched; the user will delete it.
- The new path has its own empty Claude Code memory folder, so no context carried over from earlier sessions. This log is the record.

---

## 2026-11-17: Bundled DeepSpace skill missing after scaffold

**Expected:** docs.deep.space (project structure page) says the scaffold creates `AGENTS.md` and `CLAUDE.md`, both pointing at a bundled skill in `.agents/skills/deepspace/`.

**Found:** `npm create deepspace@latest .` (deepspace 0.44.2) created `AGENTS.md` and a template `CLAUDE.md`. Because a `CLAUDE.md` already existed, the template's version was written to `CLAUDE.deepspace.md`. There was **no `.agents/` folder** and no `skills-lock.json`. The generated `AGENTS.md` itself says the skill is optional and installed separately. The docs page lags this version.

**Fix:** Reinstalled with `npx -y skills@latest add deepdotspace/deepspace-skill -y`. Verified:
- `.claude\skills\deepspace` is a Windows junction to `.agents\skills\deepspace`.
- `SKILL.md` resolves through the link, and no files are read-only.
- After a session restart, the `deepspace` skill loaded.

---

## 2026-11-17: Setup (scaffold, register, run, deploy)

**Asked:** Setup only, no features. Check the environment and auth, compare templates, scaffold, run locally, deploy, and document the structure.

**Built and verified:**
- **Environment:** Node v26.13.1 (supported), npm/npx 12.2.3. DeepSpace auth was already valid (developer account).
- **Template:**
  - Agent compared `starter` and `copilot` and **recommended copilot**, because its built-in chat dock sits beside the board.
  - **User chose `starter`.** AI chat can be added later with `npx deepspace add ai-chat`.
- **Scaffold:** `npm create deepspace@latest . -- --template starter`. The user's `CLAUDE.md` was merged below the template's one-line version (`See [AGENTS.md](./AGENTS.md).`), and `CLAUDE.deepspace.md` was removed. The user committed the scaffold and pushed it to GitHub.
- **Source of truth:** **User decided GitHub is the code repo** (`aankouni12/DeepSpace_Job_Tracker`). DeepSpace is used only for hosting. The first deploy claimed GitHub as the app's source permanently; DeepSpace `push`/`pull` now refuse.
- **Name:** Agent proposed `deepspace-job-tracker`. **User chose `applytrack`.** Updated:
  - `name` and `APP_NAME` in `wrangler.toml`
  - `APP_NAME` in `src/constants.ts`
  - `<title>` in `index.html`
- **Registration:**
  - The first `dev start` refused with exit 2, `placeholder_committed`. The scaffold commit already contained the `__APP_ID__` placeholder, so the CLI would not create an id automatically.
  - Ran `npx deepspace app init`, which registered `app_01M7P97V5G7E91CNSA08EPWQ0F`. Committed with the rename as `4f22acb` after the user reviewed the diff.
- **Local run:**
  - `dev start` served http://localhost:5173. `/` returned 200; `/api/integrations/status` returned 401 (worker up, auth enforced).
  - `npx deepspace test run --port 5180` passed 8/8 Playwright smoke and API tests.
- **Deploy:**
  - `git status` was clean first. `npx deepspace deploy` succeeded: live at **https://applytrack.app.space**, edge and data plane confirmed.
  - On the live app, `/` returned 200 with title applytrack, `/api/integrations/status` returned 401, and the logs showed readiness checks ok.
- **Docs:** wrote `ARCHITECTURE.md` (layout, components, data model, request flow) and this log.

**Changed by user:**
- `/security-review` failed: `origin/HEAD` did not exist locally. It also compares commits, so it cannot review uncommitted changes on a single `main` branch.
  - User accepted a manual review for the rename commit (config and display text only; the app id is a public identifier).
  - Ran `git remote set-head origin -a`.
- **New workflow:** one feature branch per feature. Commit on the branch, run `/security-review` against `main`, merge to `main`, push, deploy from `main`. `CLAUDE.md` Security section updated (commit `819fe0b`).
- Before every deploy, check `git status` and stop if there are uncommitted changes.

**Open items for the first feature:**
- The scaffold's AI tools include `records.update` and `records.delete`. These must be restricted before the assistant ships (email content is untrusted).
- `settings` and `users` are scaffold collections. Job-tracker collections are not defined yet.

---

## 2026-11-17: Roadmap and feature 1 (data model)

**Asked:**
- Status check and a plan for the remaining work.
- **User revised the roadmap:**
  - Move a per-user Gmail spike to Wednesday, right after the data model. Test `gmail-list` from a route and from a job, as the user.
  - Demo mode runs through the same sync job and classifier, using an email source (`gmail | demo`), about 10 emails.
  - Check how AI calls in jobs are billed, so demo works for a reviewer with no credits.
  - Add `gmailMessageId` (unique), `lastActivityAt`, `source`, and a `not_job_related` classification.
  - Board cards get a status dropdown.

**Built (branch `feature/data-model`):**
- `src/schemas/applications-schema.ts` and `src/schemas/emails-schema.ts`, registered in `src/schemas.ts`.
- The docs showed that `'own'` defaults to the row's creator. The sync job will create the rows, so both collections use `ownerField: 'userId'`.
  - `userId` is not `userBound`: the docs say not to use it when only server code creates rows.
  - `applications`: users can update only `status` (`writableFields`).
  - `emails`: read-only for users.
  - Admin is `'own'` too.
  - Uniqueness rules are per user (`userId` plus `key` or `gmailMessageId`), so all demo users can share seeded IDs.
- Not-job-related emails are stored as ID plus label only. `from`, `subject` and `snippet` stay empty, so unrelated mail isn't kept, and re-syncs still skip them.

**Verified:**
- `tsc` and `eslint`: clean.
- `src/schemas/permissions.test.ts` (vitest, 10 tests) passes through the SDK's own `canRead`/`canUpdate`/`canCreate`/`canDelete`/`checkFieldPermissions`/`lintSchemas`:
  - Owner reads; other users and admins don't.
  - No client creates or deletes.
  - Only `status` is writable.
  - Emails are read-only.
  - No schema-lint warnings.
- Playwright smoke and API: 8/8 with the new schemas loaded.

**Deviation from the approved plan:**
- The plan called for a two-user Playwright test (`tests/data-model.spec.ts`). It was replaced with the vitest unit test above, for two reasons:
  - The test-account pool is empty.
  - With `create: false` for every client role, seeding rows needs the admin-only `/api/debug` SQL route.
- A browser-level two-user test fits better once the demo sync can create rows (feature 3). User to confirm.

**Problem found:** every vitest suite, including the scaffold's own, failed with "Vitest failed to find the current suite".
- Hypothesis: the working directory was lowercase `c:\dev\...` while vitest resolves `C:/dev/...`, so Node loads vitest twice.
- Test: reran from uppercase `C:\dev\deepspace-job-tracker`, and all 13 tests passed. No code change; unit tests run from `C:\`.

**Follow-up before merging feature 1 (2026-11-17, requested by user):**
- Agent explained uniqueness:
  - `gmailMessageId` is unique per user (`uniqueOn: ['userId', 'gmailMessageId']`).
  - `applications.key` will be built by sync code as normalized `company|role`. Not implemented yet.
- Agent listed the denial cases `permissions.test.ts` covers.
- User added two Security rules to CLAUDE.md:
  - Sync and demo code sets `userId` only from the verified caller.
  - Never set `ALLOW_DEBUG_ROUTES` on the deployed app.
- Live check after deploy:
  - `secrets list` was empty.
  - `schema_list` showed both collections.
  - `records_create` on `applications` as the owner was refused with `CREATE DENIED: role=admin`.
  - `logs --search schema-lint` returned 0 warnings.

---

## 2026-11-18: Spike, can background code read Gmail as the user?

**Asked:** On a throwaway branch (`spike/gmail-as-user`, never merged), answer four questions from docs.deep.space and the SDK, then prove them with the smallest tests:
1. Can a job read Gmail as the user who started it?
2. If not, what is the documented way?
3. Who pays for AI calls from server code?
4. What do `gmail-list`'s parameters, scopes and messages look like?

**Findings (docs and deepspace 0.44.2 types):**
- **Q1, no.** A job knows only `job.enqueuedBy`, a user ID. It holds no JWT, and `JobContext` has none either. The only server credential is `APP_OWNER_JWT`. Google tokens are stored per JWT subject (Google OAuth guide), so the owner's JWT reads the owner's mailbox. `enqueuedBy` itself is trustworthy: for browser-started jobs it comes from the verified WebSocket user (`dist/worker.js:4888`).
- **Q2, none for `google/*`.** Only Composio documents background access, via `callComposio(..., { asUser })`, which sends the owner JWT plus `x-act-as-user`. Nothing says the API worker honors that header for Google.
- **Q3, the JWT subject pays.** `createDeepSpaceAI` with no `authToken` falls back to `APP_OWNER_JWT`, so the owner pays. There's no billing override. `google/*` must stay user-billed, and test accounts have no credits, so user-billed calls fail with 402.
- **Q4.** `gmail-list` returns message IDs only. **`gmail-inbox` lists and fetches messages in one call** ($0.013, up to 50 per page, takes `q`, `format`, `labelIds`, `pageToken`), so the design uses it.
- **Also found: the job queue is visible to every member.** Read access defaults to write access (`dist/worker.js:4814`), and write access defaults to member/admin (`worker.js:4813`, and our `worker.ts:72`). Each broadcast sends the full job to every authorized socket (`worker.js:5226-5240`). The job view includes `payload`, `result` and `progressMessage` (`worker.js:5374`, `rowToJobView`), and it goes out on enqueue, progress, success and failure (`worker.js:1344-1350`). Email content in a job would therefore reach every signed-in member.

**Tests run:**
- **T1** (user, browser console on the live app, no code): `POST /api/integrations/google/gmail-inbox` with the user's JWT, `format: metadata`, `maxResults: 3`.
  - The first call asked for consent. The user recalls the screen asking only for read access; the status flags below confirm it.
  - The second call returned HTTP 200 with `messages`, `nextPageToken` and `resultSizeEstimate`.
  - Each message has `id`, `threadId`, `labelIds`, `snippet` (201 characters), `payload` (`mimeType`, `headers`: Date, Message-ID, Subject, From, To), `sizeEstimate`, `historyId` and `internalDate` (epoch milliseconds as a string). There's no body.
  - `partialErrors` is missing when nothing failed.
- **Connection status** (`GET /api/integrations/status`): `gmailRead: true`, `gmailModify: false`, `gmailSend: false`. Calendar, Drive and Contacts are all false. **Read access only.**
- **T3** (temporary action `spikeAiBilling`, one Haiku call with no `authToken`):
  - Called by the owner: HTTP 200, and the owner's usage showed `anthropic` count 1.
  - **T3b:** a zero-credit, **non-owner** test account (`reviewer@deepspace.test`) called it from a throwaway Playwright spec. HTTP 200, and the owner's usage went to `anthropic` count 2. **Proven: AI from an action bills the owner whoever the caller is.**
- **T2** (`x-act-as-user` for Google) **skipped by user decision.** We won't depend on undocumented behavior.

**Decisions (user):**
1. Sync is a **user-triggered server action**. No jobs or cron for sync.
2. T2 skipped, as above.
3. Daily re-sync becomes **sync on open** when the last sync was more than 24 hours ago.
4. Owner-billed AI, so reviewers without credits can use demo mode.
5. Design additions:
   - Rate limit of one sync per user per 10 minutes, so nobody can burn the owner's AI credits.
   - At most 50 messages per sync.
   - Records are written after each AI batch, so cards appear live; the UI shows a syncing state.
- CLAUDE.md core path and ARCHITECTURE.md (new Sync section) updated to match.

**Cleanup:** the spike action and spec were deleted, and the spike branch (no commits) was deleted. The test account was kept for feature 3's two-user test. Its password is only in `~/.deepspace/test-accounts.json`, outside the repo.

**Issues noticed (not fixed):**
- **Dev server exit.** The first `dev start` after adding the `ai` import printed `Dev server exited with code 1`, but Vite kept running on port 5173, so the next `dev start` hit `port_in_use`. Cleaned up with `dev kill --port 5173`.
- **CLI login token.** It's accepted as a bearer token by local dev but rejected by the live app (401).
- **Unexplained spend.** Account-wide `app usage` jumped by about 2.58 credits between T3 and T3b. This app's itemized usage shows only about $0.026 of Gmail and about $0.00001 of AI. `app usage` covers all apps on the account, so the source is unknown. **The user should check it.**
