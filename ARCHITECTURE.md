# Architecture

applytrack is a job application tracker built on the DeepSpace SDK. It runs as one Cloudflare Worker with a Vite + React frontend.

- Live: https://applytrack.app.space
- App id: `app_01M7P97V5G7E91CNSA08EPWQ0F` (immutable; data and secrets key to it)
- Source: GitHub (`aankouni12/DeepSpace_Job_Tracker`, `main`). This was claimed permanently at the first deploy. Deploys ship the local working tree.

**Status:** unmodified `starter` scaffold (deepspace 0.44.2), renamed to applytrack. No job-tracker features yet. Sections marked *planned* describe intent, not code.

## Project layout

```
worker.ts                  Worker entry: Hono app, route registration order, Durable Object classes
wrangler.toml              Cloudflare config: name (subdomain), DEEPSPACE_APP_ID, DO bindings
index.html                 HTML shell; loads src/main.tsx
vite.config.ts             Vite + Cloudflare plugin; injects DEEPSPACE_APP_ID into the build
prerender.ts               Build step that pre-renders static public pages (the landing)

src/
  main.tsx                 Browser entry: file-based router (generouted), hydrate or render
  constants.ts             APP_NAME, APP_ID, SCOPE_ID = `app:${APP_ID}`
  nav.ts                   Navigation bar entries
  schemas.ts               Array of every collection schema (shared by worker and frontend)
  schemas/                 One file per collection (users-schema.ts, admin-schema.ts)
  pages/                   Routes. Folder determines what a page gets (see below)
  components/              App components; components/ui/ holds local UI primitives
  server/
    http-routes.ts         Auth proxy, integrations proxy, files, static/SPA fallback
    realtime-routes.ts     WebSocket routes to Durable Objects, with JWT verification
    action-routes.ts       POST /api/actions/:name (server actions)
  actions/index.ts         Server action handlers (empty)
  ai/
    tools.ts               buildTools: AI tool definitions over records
    agent.ts               registerAgent: exposes tools over HTTP / MCP / browser
    chat-routes.ts         Chat endpoints (used only when an ai-chats schema exists)
  cron.ts                  Scheduled tasks (empty)
  jobs.ts                  Background job handler (empty)
  integrations.ts          Integration billing: google and composio are 'user'-billed

tests/                     Playwright: smoke.spec.ts, api.spec.ts (default run), collab.spec.ts
public/                    Static files (favicon, robots.txt, _headers)
.agents/skills/deepspace/  DeepSpace agent skill (linked from .claude/skills/deepspace)
```

### Where things live

| Concern | Location |
|---|---|
| Frontend | `src/main.tsx`, `src/pages/`, `src/components/` |
| Worker (backend) | `worker.ts` plus `src/server/`, `src/actions/`, `src/ai/`, `src/cron.ts`, `src/jobs.ts` |
| Schemas and permissions | `src/schemas.ts` and `src/schemas/*.ts`. Baked in at deploy time, so a schema change needs a redeploy |
| Config | `wrangler.toml` (identity, bindings) and `src/integrations.ts` (billing) |
| Secrets | `npx deepspace secrets` only. `.dev.vars` is generated and gitignored |

### Page folders

Generouted maps files to URLs. A parenthesised folder name is a group and does not appear in the URL.

| Folder | URL example | What the page gets |
|---|---|---|
| `src/pages/*.tsx` | `/` | Static: pre-rendered, no auth request, no WebSocket |
| `src/pages/(app)/*.tsx` | `/home` | Auth and record providers mounted; sign-in optional |
| `src/pages/(app)/(protected)/*.tsx` | `/settings` | Same, plus `AuthGate`: sign-in required |

`src/pages/(app)/_layout.tsx` mounts `DeepSpaceAuthProvider`, then `RecordProvider` and `RecordScope(SCOPE_ID)`. Data hooks (`useQuery`, `useMutations`, `useAuth`) only work below it.

## Components

**Worker (`worker.ts`).** A Hono app. Route registration order is part of the contract:

1. `registerAuthAndIntegrationRoutes`: `/api/auth/*` (proxied to the DeepSpace auth worker), `/api/integrations/*` (proxied to the platform API worker with the caller's JWT)
2. `registerRealtimeRoutes`: `/ws/*` WebSockets to Durable Objects
3. `registerActionRoutes`: `POST /api/actions/:name`
4. `registerAgent`: AI tools over HTTP / MCP / browser. In-app chat routes stay off because the starter has no ai-chats schema
5. `registerPlatformProxyRoutes`: `/api/files/*`, `/_deepspace/*`
6. `registerStaticRoutes`: built assets, then the SPA shell for client routes

Middleware on every request wakes the cron room so schedules arm without waiting for a visitor.

**Durable Objects.** Each is a SQLite-backed instance, keyed by name:

| Class | Binding | Role |
|---|---|---|
| `AppRecordRoom` | `RECORD_ROOMS` | The database: collections from `schemas.ts`, RBAC enforced per record, live sync over WebSocket |
| `AppCronRoom` | `CRON_ROOMS` | Runs `src/cron.ts` tasks on an alarm |
| `AppJobRoom` | `JOB_ROOMS` | Durable background jobs (`src/jobs.ts`); only members and admins may enqueue |
| `AppYjsRoom`, `AppCanvasRoom`, `AppPresenceRoom` | `YJS_ROOMS`, `CANVAS_ROOMS`, `PRESENCE_ROOMS` | Collaborative editing, canvas and presence. Not used by this app |

The app's main record room is the instance named `app:<DEEPSPACE_APP_ID>` (`SCOPE_ID`). It is keyed to the id, not the name, so a rename keeps the data.

**Platform services (outside this repo).** The DeepSpace auth worker handles sign-in (GitHub, Google), JWTs and sessions. The API worker handles integrations: Google OAuth and Gmail, with tokens stored per user.

## Data model

Current (scaffold):

| Collection | Purpose | Permissions |
|---|---|---|
| `users` | Platform user profile (`USERS_COLUMNS`); required, do not rename | viewer/member: read and update own; admin: all |
| `settings` | App settings (`admin-schema.ts`) | admin |

*Planned:* `applications` (one per company and role, with status Applied, Interview, Offer or Rejected) and an email timeline. Every collection will use `own` read and write permissions so users see only their own records.

## Data flow

### Reading and writing records (the main path)

1. The browser loads `index.html`. `main.tsx` routes to a page under `(app)/`.
2. `DeepSpaceAuthProvider` gets the session from `/api/auth/*`, which proxies to the auth worker, and receives a JWT.
3. `RecordScope` opens a WebSocket to `/ws/app:<APP_ID>?token=<jwt>`.
4. `realtime-routes.ts` verifies the JWT and strips any client-supplied identity. It then forwards the request to the `AppRecordRoom` Durable Object with the verified identity in internal headers.
5. The record room checks each read and write against that collection's permissions (`own`, role), then writes to its SQLite storage.
6. Every connected client whose permissions allow it receives the change over its WebSocket. This is how the pipeline board will update in real time.

The browser never talks to the database directly; the WebSocket in step 3 is the data channel. Writes are fire-and-forget, so a rejected write comes back through `onWriteError` and is shown as a toast.

### Server actions

`POST /api/actions/:name` with a bearer JWT goes through `resolveAuth` to the handler in `src/actions/`. Actions reach records with **RBAC off**, so each action must check ownership itself.

### Integrations (*planned*: Gmail)

The frontend calls `/api/integrations/google/gmail-list`, and the worker forwards it with the user's JWT. Google is `user`-billed, so each user connects their own Gmail. An unconnected user gets `data.requiresOAuth` and an `authUrl`.

### Background work (*planned*)

`src/cron.ts` holds a daily task that enqueues jobs. `src/jobs.ts` runs in `AppJobRoom`: it fetches email, classifies it with AI in batches, and writes records. Cron runs as the app owner, so per-user scoping must be explicit.

### AI assistant (*planned*)

`src/ai/tools.ts` defines the tools; they run as the calling user, so record permissions still apply. The scaffold's defaults include `records.update` and `records.delete`. Email content is untrusted, so those defaults will be restricted before the assistant ships.

## Build and deploy

- Local: `npx deepspace dev start` runs Vite and the worker (miniflare) on http://localhost:5173.
- Tests: `npx deepspace test run` (smoke and API); `test run all` includes collab.
- Deploy: from `main` after merging a feature branch. Run `git status` first, since deploys ship the working tree. Then `npx deepspace deploy`.
