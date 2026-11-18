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
