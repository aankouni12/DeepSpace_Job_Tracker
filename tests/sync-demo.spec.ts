/**
 * Demo sync end to end, as two zero-credit test accounts (AI bills the owner).
 * Records are read through the agent tools as the signed-in user, so the
 * collections' permissions apply exactly as they do for the app.
 *
 * Re-runnable: local state can persist between runs, so a first call may be
 * rate_limited; assertions are on the resulting records.
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

type Row = { recordId: string; data: Record<string, unknown> }

async function rows(page: Page, collection: string): Promise<Row[]> {
  const res = await post(page, '/_deepspace/agent/browser/tools/records_query', {
    input: { collection, limit: 200 },
  })
  const records = res.json?.result?.data?.records ?? res.json?.data?.records ?? res.json?.records
  if (!Array.isArray(records)) throw new Error(`records_query ${collection}: ${JSON.stringify(res)}`)
  return records
}

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

async function expectDemoData(page: Page, userId?: string) {
  // Labels: every demo email recorded once, with the expected label. The
  // injection email (demo-9) must not change any other label.
  const emails = await rows(page, 'emails')
  const labels = Object.fromEntries(emails.map((r) => [r.data.gmailMessageId, r.data.classification]))
  expect(labels).toEqual(EXPECTED_LABELS)

  // Applications: exactly the three real ones; no stray "Acme" application.
  const apps = await rows(page, 'applications')
  const statuses = Object.fromEntries(apps.map((r) => [r.data.key, r.data.status]))
  expect(statuses).toEqual(EXPECTED_APPS)
  expect(apps.some((r) => String(r.data.key).includes('acme'))).toBe(false)

  // Not-job-related rows keep no content.
  for (const r of emails.filter((r) => r.data.classification === 'not_job_related')) {
    expect([r.data.from, r.data.subject, r.data.snippet].every((v) => !v)).toBe(true)
  }

  // Everything visible belongs to this user.
  const owners = new Set([...emails, ...apps].map((r) => r.data.userId))
  expect(owners.size).toBe(1)
  if (userId) expect([...owners]).toEqual([userId])
  return [...owners][0]
}

test('demo sync: labels, injection, rate limit, isolation, delete', async ({ users }) => {
  test.setTimeout(180_000)
  const [a, b] = await users(['Reviewer', 'Reviewer Two'])
  await Promise.all([a.page.goto('/home'), b.page.goto('/home')])

  const first = await post(a.page, '/api/actions/sync', { source: 'demo' })
  console.log('SYNC_1 ' + JSON.stringify(first.json))
  expect(first.status).toBe(200)
  test.skip(
    !first.json.success && (await rows(a.page, 'emails')).length === 0,
    'A deleted its data in a run less than 10 minutes ago and is still rate-limited; ' +
      'wait, or rm -rf .wrangler/state for a fresh local run.',
  )
  if (first.json.success) {
    const d = first.json.data
    expect(d.failedBatches).toBe(0)
    // Diagnostics: short ids map back cleanly; the model labeled all 10.
    expect(d.rejected).toEqual({ unknownId: 0, badLabel: 0, noCompany: 0, notGrounded: 0 })
    expect(Object.values(d.modelLabels as Record<string, number>).reduce((x, y) => x + y, 0)).toBe(12)
  } else {
    expect(first.json.code).toBe('rate_limited')
  }

  const aUser = await expectDemoData(a.page)

  // Rate limit: an immediate second sync is refused.
  const second = await post(a.page, '/api/actions/sync', { source: 'demo' })
  expect(second.json).toMatchObject({ success: false, code: 'rate_limited' })

  // B syncs its own demo data; each sees only their own rows.
  const bSync = await post(b.page, '/api/actions/sync', { source: 'demo' })
  expect(bSync.json.success || bSync.json.code === 'rate_limited').toBe(true)
  const bUser = await expectDemoData(b.page)
  expect(bUser).not.toBe(aUser)
  expect((await rows(a.page, 'syncState')).length).toBe(1)

  // A deletes its data: only A's emails and applications go; the rate-limit
  // timestamp stays, so A cannot delete-and-resync to burn owner AI credits.
  const del = await post(a.page, '/api/actions/deleteMyData', { userId: bUser }) // param is ignored
  expect(del.json).toEqual({ success: true, data: { deleted: { emails: 12, applications: 5 } } })
  expect(await rows(a.page, 'emails')).toEqual([])
  expect(await rows(a.page, 'applications')).toEqual([])
  const [state] = await rows(a.page, 'syncState')
  expect(state.data.lastSyncAt).toBeTruthy()
  expect(state.data.cursorAt ?? null).toBeNull()
  const afterDelete = await post(a.page, '/api/actions/sync', { source: 'demo' })
  expect(afterDelete.json).toMatchObject({ success: false, code: 'rate_limited' })

  // B is untouched.
  await expectDemoData(b.page, bUser)
})
