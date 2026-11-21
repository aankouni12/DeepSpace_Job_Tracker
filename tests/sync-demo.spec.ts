/**
 * Demo sync end to end, as two zero-credit test accounts (AI bills the owner).
 * Records are read through the agent tools as the signed-in user, so the
 * collections' permissions apply exactly as they do for the app.
 *
 * Re-runnable: local state can persist between runs (B keeps its demo data),
 * so assertions are on the resulting records. Demo syncs are exempt from the
 * per-user 10-minute limit (reviewer fix, 2026-11-20); only the app-wide daily
 * cap applies, and only when something new goes to the AI.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import type { Page } from '@playwright/test'

test.skip(
  loadAllTestAccounts().length < 2,
  'Needs the Reviewer and Reviewer Two test accounts (npx deepspace test accounts list).',
)

async function post(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const t = await fetch('/api/auth/token', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })
      const { token } = await t.json()
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      return { status: r.status, json: await r.json() }
    },
    { path, body },
  )
}

// Read through the assistant's own tools (the only agent tools there are).
// They return metadata only; the checks on stored content, userId and
// syncState fields are unit tests in src/actions/sync.test.ts.
async function tool<T>(page: Page, name: string, input: Record<string, unknown> = {}): Promise<T> {
  const res = await post(page, `/_deepspace/agent/browser/tools/${name}`, { input })
  if (!res.json?.ok) throw new Error(`${name}: ${JSON.stringify(res)}`)
  return res.json.result as T
}

type App = { id: string; company: string; role: string; status: string }
type EmailEvent = { messageId: string; classification: string }

const apps = async (page: Page) => (await tool<{ applications: App[] }>(page, 'list_applications')).applications
const emailEvents = async (page: Page) =>
  (await tool<{ events: EmailEvent[] }>(page, 'list_email_events', { includeUnrelated: true })).events
// The demo cards show "Cedar Labs Inc."; the stored key drops the suffix.
const keyOf = (a: App) => `${a.company.toLowerCase().replace(/,?\s+inc\.?$/, '')}|${a.role.toLowerCase()}`

const EXPECTED_LABELS: Record<string, string> = {
  'demo-1': 'applied',
  'demo-2': 'applied',
  'demo-3': 'applied',
  'demo-4': 'interview',
  'demo-5': 'rejected',
  'demo-6': 'interview',
  'demo-7': 'not_job_related',
  'demo-8': 'offer',
  'demo-9': 'not_job_related', // prompt injection
  'demo-10': 'not_job_related',
  'demo-11': 'applied', // take-home task, not an interview
  'demo-12': 'rejected', // rejection only in paragraph 2 of the body
}

const EXPECTED_APPS: Record<string, string> = {
  'northwind robotics|software engineer intern': 'offer',
  'bluefin analytics|data analyst': 'rejected',
  'cedar labs|product designer': 'interview',
  'kestrel systems|backend developer': 'applied',
  'maple ridge software|qa engineer': 'rejected',
}

/** Checks the demo data and returns this user's application ids. */
async function expectDemoData(page: Page): Promise<string[]> {
  // Labels: every demo email recorded once, with the expected label. The
  // injection email (demo-9) must not change any other label.
  const labels = Object.fromEntries((await emailEvents(page)).map((e) => [e.messageId, e.classification]))
  expect(labels).toEqual(EXPECTED_LABELS)

  // Applications: exactly the five real ones; no stray "Acme" application.
  const mine = await apps(page)
  expect(Object.fromEntries(mine.map((a) => [keyOf(a), a.status]))).toEqual(EXPECTED_APPS)
  expect(mine.some((a) => /acme/i.test(a.company))).toBe(false)
  return mine.map((a) => a.id).sort()
}

test('demo sync: labels, injection, repeat, isolation, delete', async ({ users }) => {
  test.setTimeout(180_000)
  const [a, b] = await users(['Reviewer', 'Reviewer Two'])
  await Promise.all([a.page.goto('/home'), b.page.goto('/home')])

  // A starts empty (this spec deletes A's data at the end of every run).
  const first = await post(a.page, '/api/actions/sync', { source: 'demo' })
  console.log('SYNC_1 ' + JSON.stringify(first.json))
  expect(first.status).toBe(200)
  test.skip(
    first.json.code === 'demo_limited',
    "A has used its 5 demo syncs for today (each run deletes and reloads A's demo). " +
      'rm -rf .wrangler/state for a fresh local run.',
  )
  expect(first.json.success).toBe(true)
  const d = first.json.data
  if (d.classified > 0) {
    expect(d.failedBatches).toBe(0)
    // Diagnostics: short ids map back cleanly; the model labeled all 12.
    expect(d.rejected).toEqual({ unknownId: 0, badLabel: 0, noCompany: 0, notGrounded: 0 })
    expect(Object.values(d.modelLabels as Record<string, number>).reduce((x, y) => x + y, 0)).toBe(12)
  }

  const aIds = await expectDemoData(a.page)

  // An immediate second demo sync is not rate-limited; with nothing new it
  // sends nothing to the AI and changes nothing.
  const second = await post(a.page, '/api/actions/sync', { source: 'demo' })
  expect(second.json).toMatchObject({ success: true, data: { classified: 0, applicationsCreated: 0 } })
  expect(await expectDemoData(a.page)).toEqual(aIds)

  // B syncs its own demo data; each sees only their own rows.
  const bSync = await post(b.page, '/api/actions/sync', { source: 'demo' })
  expect(bSync.json.success).toBe(true)
  const bIds = await expectDemoData(b.page)
  expect(aIds.filter((id) => bIds.includes(id))).toEqual([])

  // A deletes its data: only A's emails and applications go. (A delete-and-
  // resync demo loop is bounded by the app-wide daily sync cap, unit-tested
  // in src/actions/sync.test.ts.)
  const del = await post(a.page, '/api/actions/deleteMyData', { userId: 'someone-else' }) // param is ignored
  expect(del.json).toEqual({ success: true, data: { deleted: { emails: 12, applications: 5 } } })
  expect(await emailEvents(a.page)).toEqual([])
  expect(await apps(a.page)).toEqual([])

  // B is untouched.
  expect(await expectDemoData(b.page)).toEqual(bIds)
})

// Reviewer Two is a zero-credit account: the real api-worker answers
// gmail-inbox with 402 insufficient_credits (before any OAuth check).
test('Gmail sync without credits: the credits message, not an empty inbox; demo data kept', async ({ users }) => {
  test.setTimeout(120_000)
  const [b] = await users(['Reviewer Two'])
  await b.page.goto('/board')
  await expect(b.page.getByTestId('application-card').first()).toBeVisible({ timeout: 30_000 }) // demo from the test above
  const before = (await apps(b.page)).length
  await b.page.getByRole('button', { name: /^(Connect|Sync) Gmail$/ }).click()
  const status = b.page.getByTestId('sync-status')
  await expect(status).toHaveText(
    'Gmail sync needs DeepSpace credits on your account. Try demo data to see how applytrack works.',
    { timeout: 30_000 },
  )
  await expect(status).not.toContainText('Synced')
  expect((await apps(b.page)).length).toBe(before)
})

// Whole-app security review (2026-11-21): the scaffold's generic integration
// proxy billed the owner for every unlisted integration. Only the caller's own
// connection status stays; Gmail is read by the sync action server-side (the
// credits test above reaches the real gmail-inbox through the action).
test('closed routes: integrations proxy, files, unused rooms; status still works', async ({ users }) => {
  const [a] = await users(['Reviewer'])
  const sockets: string[] = []
  a.page.on('websocket', (ws) => sockets.push(new URL(ws.url()).pathname))
  await a.page.goto('/board')
  await expect(a.page.getByTestId('first-run').or(a.page.getByTestId('application-card').first())).toBeVisible({ timeout: 30_000 })

  const call = (method: string, path: string, body?: unknown) =>
    a.page.evaluate(
      async ({ method, path, body }) => {
        const { token } = await (await fetch('/api/auth/token', { method: 'POST', credentials: 'include' })).json()
        const r = await fetch(path, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: r.status, text: (await r.text()).slice(0, 200) }
      },
      { method, path, body },
    )

  // Signed in, an owner-billed (unlisted) integration is gone.
  expect((await call('POST', '/api/integrations/openai/chat', { messages: [] })).status).toBe(404)
  expect((await call('POST', '/api/integrations/email/send', {})).status).toBe(404)
  // Gmail via this route too (it's read by the sync action instead).
  expect((await call('POST', '/api/integrations/google/gmail-inbox', {})).status).toBe(404)
  // The catalog and disconnect routes, and the files proxy.
  expect((await call('GET', '/api/integrations')).status).toBe(404)
  expect((await call('DELETE', '/api/integrations/oauth/google/disconnect')).status).toBe(404)
  expect((await call('GET', '/api/files/anything')).status).toBe(404)
  expect((await call('POST', '/api/files/upload', {})).status).toBe(404)
  // The caller's own connection status still works (the board needs it).
  const status = await call('GET', '/api/integrations/status')
  expect(status.status).toBe(200)
  expect(status.text).toContain('gmailRead')

  // The board opens only the records socket, never the removed rooms. (Vite's
  // own HMR socket at "/" is a dev-server artifact; only /ws/* is the app's.)
  await a.page.waitForTimeout(1000)
  const appSockets = sockets.filter((p) => p.startsWith('/ws/'))
  expect(appSockets.length).toBeGreaterThan(0)
  for (const path of appSockets) expect(path).toMatch(/^\/ws\/[^/]+$/)
})

test('agent tool surface: only the three assistant tools, over HTTP and MCP', async ({ users }) => {
  const [a] = await users(['Reviewer'])
  await a.page.goto('/home')
  const expected = ['list_applications', 'list_email_events', 'propose_status_change']

  const http = await a.page.evaluate(async () => {
    const { token } = await (await fetch('/api/auth/token', { method: 'POST', credentials: 'include' })).json()
    const r = await fetch('/_deepspace/agent/browser/tools', { headers: { Authorization: `Bearer ${token}` } })
    return r.json()
  })
  expect((http.tools as { name: string }[]).map((t) => t.name).sort()).toEqual(expected)

  const mcp = await post(a.page, '/_deepspace/agent/browser/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  expect((mcp.json.result.tools as { name: string }[]).map((t) => t.name).sort()).toEqual(expected)

  // A removed tool can't be called by name either.
  const write = await post(a.page, '/_deepspace/agent/browser/tools/records_update', {
    input: { collection: 'applications', recordId: 'x', data: { status: 'offer' } },
  })
  expect(write.status).toBe(404)
})
