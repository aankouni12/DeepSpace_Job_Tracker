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
}

const EXPECTED_APPS: Record<string, string> = {
  'northwind robotics|software engineer intern': 'offer',
  'bluefin analytics|data analyst': 'rejected',
  'cedar labs|product designer': 'interview',
}

test('demo sync: labels, applications, injection, rate limit, isolation', async ({ users }) => {
  test.setTimeout(120_000)
  const [a, b] = await users(['Reviewer', 'Reviewer Two'])
  await Promise.all([a.page.goto('/home'), b.page.goto('/home')])

  const first = await post(a.page, '/api/actions/sync', { source: 'demo' })
  console.log('SYNC_1 ' + JSON.stringify(first.json))
  expect(first.status).toBe(200)
  if (!first.json.success) expect(first.json.code).toBe('rate_limited')
  else expect(first.json.data.failedBatches).toBe(0)

  // Labels: every demo email recorded once, with the expected label. The
  // injection email (demo-9) must not change any other label.
  const emails = await rows(a.page, 'emails')
  const labels = Object.fromEntries(emails.map((r) => [r.data.gmailMessageId, r.data.classification]))
  expect(labels).toEqual(EXPECTED_LABELS)

  // Applications: exactly the three real ones; no stray "Acme" application.
  const apps = await rows(a.page, 'applications')
  const statuses = Object.fromEntries(apps.map((r) => [r.data.key, r.data.status]))
  expect(statuses).toEqual(EXPECTED_APPS)
  expect(apps.some((r) => String(r.data.key).includes('acme'))).toBe(false)

  // Not-job-related rows keep no content.
  for (const r of emails.filter((r) => r.data.classification === 'not_job_related')) {
    expect([r.data.from, r.data.subject, r.data.snippet].every((v) => !v)).toBe(true)
  }

  // Rate limit: an immediate second sync is refused.
  const second = await post(a.page, '/api/actions/sync', { source: 'demo' })
  expect(second.json).toMatchObject({ success: false, code: 'rate_limited' })

  // Own sync state is readable; nobody else's is.
  expect((await rows(a.page, 'syncState')).length).toBe(1)

  // Isolation: the other user sees none of A's rows.
  for (const collection of ['emails', 'applications', 'syncState']) {
    expect(await rows(b.page, collection)).toEqual([])
  }
})
