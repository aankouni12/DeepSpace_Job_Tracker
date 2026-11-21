import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import {
  APP_DEMO_DAILY_LIMIT,
  APP_GMAIL_DAILY_LIMIT,
  buildGmailQuery,
  classifyAndWrite,
  clearDemoData,
  cleanRole,
  DEMO_DAILY_LIMIT,
  deleteMyData,
  emptyStats,
  extractText,
  nextStatus,
  normalizeKey,
  parseGmailMessage,
  remapIds,
  resolveCompany,
  sync,
  validateBatch,
  type Classified,
  type InboxEmail,
} from './sync'

// The model call is mocked; every other line of the actions runs for real.
const generateObject = vi.hoisted(() => vi.fn())
vi.mock('ai', () => ({ generateObject }))
vi.mock('deepspace/worker', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createDeepSpaceAI: () => () => 'model',
}))

describe('normalizeKey', () => {
  it('folds case, punctuation, whitespace and company suffixes', () => {
    const key = normalizeKey('autoliv', 'Software Engineer')
    expect(normalizeKey('Autoliv Inc.', 'Software Engineer')).toBe(key)
    expect(normalizeKey(' AUTOLIV, inc ', 'software   engineer!')).toBe(key)
    expect(key).toBe('autoliv|software engineer')
  })

  it('drops each listed suffix', () => {
    for (const s of ['Inc', 'LLC', 'Ltd.', 'Corp', 'Co.']) {
      expect(normalizeKey(`Acme ${s}`, 'x')).toBe('acme|x')
    }
  })

  it('only drops suffixes as separate words, never the whole name', () => {
    expect(normalizeKey('Costco', 'x')).toBe('costco|x')
    expect(normalizeKey('Co', 'x')).toBe('co|x')
    expect(normalizeKey("Macy's", 'x')).toBe('macys|x')
  })
})

describe('parseGmailMessage', () => {
  // Shape observed in the T1 spike (format: metadata).
  const message = {
    id: '18c1',
    threadId: '18c1',
    labelIds: ['INBOX'],
    snippet: 'Thanks for applying',
    payload: {
      mimeType: 'text/html',
      headers: [
        { name: 'Date', value: 'Tue, 17 Nov 2026 10:00:00 -0500' },
        { name: 'Subject', value: 'Application received' },
        { name: 'From', value: 'Jobs <jobs@example.com>' },
      ],
    },
    sizeEstimate: 1234,
    historyId: '1',
    internalDate: '1795048599000',
  }

  it('extracts id, headers, snippet and date', () => {
    expect(parseGmailMessage(message)).toEqual({
      id: '18c1',
      from: 'Jobs <jobs@example.com>',
      subject: 'Application received',
      snippet: 'Thanks for applying',
      receivedAt: new Date(1795048599000).toISOString(),
      body: '', // metadata format has no body parts
    })
  })

  it('rejects messages without an id', () => {
    expect(parseGmailMessage({ ...message, id: undefined })).toBeNull()
    expect(parseGmailMessage(null)).toBeNull()
  })
})

const email = (id: string, text: string, day: number): InboxEmail => ({
  id,
  from: `${text} <x@example.com>`,
  subject: text,
  snippet: text,
  receivedAt: new Date(Date.UTC(2026, 10, day)).toISOString(),
})

describe('validateBatch', () => {
  const batch = [email('a', 'Northwind Robotics interview', 1), email('b', 'Weekly deals', 2)]

  it('returns null when the output as a whole is unusable', () => {
    expect(validateBatch(batch, null)).toBeNull()
    expect(validateBatch(batch, { results: 'nope' })).toBeNull()
    expect(validateBatch(batch, 'garbage')).toBeNull()
  })

  it('keeps valid items and defaults the rest to not_job_related', () => {
    const out = validateBatch(batch, {
      results: [{ id: 'a', label: 'interview', company: 'Northwind Robotics', role: '' }],
    })!
    expect(out.get('a')).toEqual({ label: 'interview', company: 'Northwind Robotics', role: 'Unspecified role' })
    expect(out.get('b')?.label).toBe('not_job_related')
  })

  it('falls back per item on a bad label, missing company, or unknown id', () => {
    const out = validateBatch(batch, {
      results: [
        { id: 'a', label: 'hired!!', company: 'Northwind Robotics', role: 'x' },
        { id: 'b', label: 'offer', company: '', role: 'x' },
        { id: 'zzz', label: 'offer', company: 'Acme', role: 'x' },
      ],
    })!
    expect(out.get('a')?.label).toBe('not_job_related')
    expect(out.get('b')?.label).toBe('not_job_related')
    expect(out.has('zzz')).toBe(false)
  })

  it('matches the company on normalized forms, ignoring case and suffixes', () => {
    const autoliv = [
      { ...email('u', 'x', 1), from: 'AUTOLIV Inc. Talent <no-reply@ats.example>', subject: 'Thanks', snippet: 'We got it' },
      { ...email('v', 'x', 2), from: 'Recruiting <jobs@ats.example>', subject: 'Your application to Autoliv', snippet: '' },
    ]
    const out = validateBatch(autoliv, {
      results: [
        { id: 'u', label: 'applied', company: 'Autoliv', role: 'Engineer' },
        { id: 'v', label: 'applied', company: 'AUTOLIV, INC.', role: 'Engineer' },
      ],
    })!
    expect(out.get('u')?.label).toBe('applied')
    expect(out.get('v')?.label).toBe('applied')
  })

  it('matches whole words only', () => {
    const out = validateBatch([email('w', 'Your metadata export is ready', 1)], {
      results: [{ id: 'w', label: 'offer', company: 'Meta', role: 'x' }],
    })!
    expect(out.get('w')?.label).toBe('not_job_related')
  })

  it('rejects a company that does not appear in that email (cross-email injection)', () => {
    const out = validateBatch(batch, {
      results: [{ id: 'b', label: 'offer', company: 'Northwind Robotics', role: 'x' }],
    })!
    expect(out.get('b')?.label).toBe('not_job_related')
  })
})

describe('buildGmailQuery', () => {
  it('first sync reads the last 60 days through the filter', () => {
    const q = buildGmailQuery()
    expect(q.startsWith('newer_than:60d ')).toBe(true)
    expect(q).toContain('-category:promotions')
    expect(q).toContain('"offer letter"')
  })

  it('later syncs start one day before the cursor (epoch seconds)', () => {
    const cursor = '2026-11-18T12:00:00.000Z'
    const expected = Math.floor((Date.parse(cursor) - 86_400_000) / 1000)
    expect(buildGmailQuery(cursor).startsWith(`after:${expected} `)).toBe(true)
  })
})

describe('remapIds', () => {
  it('maps short ids back to Gmail ids; unknown ones become empty', () => {
    const batch = [email('18c1aa', 'x', 1), email('18c1bb', 'y', 2)]
    const out = remapIds(batch, {
      results: [
        { id: '2', label: 'applied' },
        { id: '1', label: 'offer' },
        { id: '9', label: 'offer' },
      ],
    }) as { results: Array<{ id: string }> }
    expect(out.results.map((r) => r.id)).toEqual(['18c1bb', '18c1aa', ''])
  })
})

describe('validateBatch stats', () => {
  it('counts model labels and rejection reasons, never content', () => {
    const batch = [
      email('a', 'Northwind Robotics', 1),
      email('b', 'Bluefin', 2),
      email('c', 'Cedar', 3),
      email('d', 'Deals', 4),
    ]
    const stats = emptyStats()
    validateBatch(
      batch,
      {
        results: [
          { id: 'a', label: 'applied', company: 'Northwind Robotics', role: 'r' },
          { id: 'b', label: 'offer', company: 'Somewhere Else', role: 'r' },
          { id: 'c', label: 'hired', company: 'Cedar', role: 'r' },
          { id: 'd', label: 'interview', company: '', role: '' },
          { id: '', label: 'offer', company: 'x', role: 'r' },
        ],
      },
      stats,
    )
    expect(stats).toEqual({
      modelLabels: { applied: 1, offer: 1, other: 1, interview: 1 },
      rejected: { unknownId: 1, badLabel: 1, noCompany: 1, notGrounded: 1 },
    })
  })
})

describe('classifyAndWrite', () => {
  // 25 emails -> batches of 10, 10, 5.
  const emails = Array.from({ length: 25 }, (_, i) => email(`m${i}`, `Acme ${i}`, 25 - i))
  const allApplied = async (batch: InboxEmail[]) => ({
    results: batch.map((e) => ({ id: e.id, label: 'applied', company: 'Acme', role: 'r' })),
  })

  it('writes nothing for a failed batch and still writes the others', async () => {
    const written: string[] = []
    let call = 0
    const result = await classifyAndWrite(
      emails,
      async (batch) => (++call === 1 ? null : allApplied(batch)),
      async (batch) => {
        written.push(...batch.map((e) => e.id))
      },
    )
    expect(result).toEqual({ classified: 15, failedBatches: 1 })
    expect(written).toHaveLength(15)
    // The failed batch was the oldest 10 (m15..m24); none of them were written.
    for (let i = 15; i < 25; i++) expect(written).not.toContain(`m${i}`)
  })

  it('treats unparseable output as a failed batch', async () => {
    const written: string[] = []
    const result = await classifyAndWrite(
      emails.slice(0, 3),
      async () => ({ unexpected: true }),
      async (batch) => {
        written.push(...batch.map((e) => e.id))
      },
    )
    expect(result).toEqual({ classified: 0, failedBatches: 1 })
    expect(written).toEqual([])
  })

  it('classifies concurrently but never runs two writes at once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let classifying = 0
    let maxClassifying = 0
    await classifyAndWrite(
      emails,
      async (batch) => {
        maxClassifying = Math.max(maxClassifying, ++classifying)
        await new Promise((r) => setTimeout(r, 5))
        classifying--
        return allApplied(batch)
      },
      async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
      },
      emptyStats(),
      undefined,
      4,
    )
    expect(maxClassifying).toBeGreaterThan(1)
    expect(maxInFlight).toBe(1)
  })

  it('by default classifies one batch at a time, each after the previous batch is written', async () => {
    const order: string[] = []
    await classifyAndWrite(
      emails,
      async (batch) => {
        order.push(`classify ${batch[0].id}`)
        return allApplied(batch)
      },
      async (batch) => {
        order.push(`write ${batch[0].id}`)
      },
    )
    expect(order).toEqual(['classify m24', 'write m24', 'classify m14', 'write m14', 'classify m4', 'write m4'])
  })
})

// ---------------------------------------------------------------------------
// Actions against an in-memory fake of ActionTools
// ---------------------------------------------------------------------------

type Row = { recordId: string; data: Record<string, unknown> }

function fakeTools(gmailPages: unknown[] = []) {
  const db: Record<string, Map<string, Row>> = {
    emails: new Map(),
    applications: new Map(),
    syncState: new Map(),
    usageTickets: new Map(),
  }
  const gmailCalls: Array<Record<string, unknown>> = []
  let n = 0
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => r.data[k] === v)
  const tools = {
    get: async (c: string, id: string) =>
      db[c].has(id) ? { success: true, data: { record: db[c].get(id) } } : { success: false, error: 'not found' },
    create: async (c: string, data: Record<string, unknown>, id?: string) => {
      // usageTickets is uniqueOn ['scope', 'n'], like the real schema.
      if (c === 'usageTickets' && [...db[c].values()].some((r) => r.data.scope === data.scope && r.data.n === data.n)) {
        return { success: false, error: `Duplicate: a record with scope=${data.scope}, n=${data.n} already exists` }
      }
      const recordId = id ?? `r${++n}`
      db[c].set(recordId, { recordId, data: { ...data } })
      return { success: true, data: { recordId } }
    },
    remove: async (c: string, id: string) => {
      db[c].delete(id)
      return { success: true, data: {} }
    },
    update: async (c: string, id: string, data: Record<string, unknown>) => {
      Object.assign(db[c].get(id)!.data, data)
      return { success: true, data: { recordId: id } }
    },
    query: async (c: string, { where }: { where: Record<string, unknown> }) => ({
      success: true,
      data: { records: [...db[c].values()].filter((r) => matches(r, where)), count: 0 },
    }),
    deleteWhere: async (c: string, where: Record<string, unknown>, limit = 100) => {
      let deleted = 0
      for (const [k, r] of db[c]) {
        if (deleted < limit && matches(r, where)) {
          db[c].delete(k)
          deleted++
        }
      }
      return { success: true, data: { deleted } }
    },
    integration: async (_endpoint: string, body: Record<string, unknown>) => {
      gmailCalls.push(body)
      const page = gmailPages.shift() as { __result?: unknown } | undefined
      if (page?.__result) return page.__result // a whole ActionResult, e.g. a failure
      return { success: true, data: page ?? { messages: [], resultSizeEstimate: 0 } }
    },
  }
  return { db, gmailCalls, tools: tools as unknown as ActionTools }
}

type Db = ReturnType<typeof fakeTools>['db']
/** Slots taken in a ticket scope. */
const ticketsIn = (db: Db, scope: string) => [...db.usageTickets.values()].filter((r) => r.data.scope === scope).length
/** Take slots 1..k of a scope, as if earlier syncs had used them. */
function fillTickets(db: Db, scope: string, k: number) {
  for (let n = 1; n <= k; n++) db.usageTickets.set(`f-${scope}-${n}`, { recordId: `f-${scope}-${n}`, data: { scope, n } })
}

const gmailMessage = (id: string, company: string, ms: number) => ({
  id,
  snippet: `Thanks for applying to ${company}`,
  internalDate: String(ms),
  payload: {
    headers: [
      { name: 'From', value: `${company} <jobs@x.example>` },
      { name: 'Subject', value: 'Application' },
    ],
  },
})

// Model stub: labels every email "applied" at the company named in its From.
function modelLabelsAllApplied() {
  generateObject.mockImplementation(async ({ prompt }: { prompt: string }) => ({
    object: {
      results: (JSON.parse(prompt).emails as Array<{ id: string; from: string }>).map((e) => ({
        id: e.id,
        label: 'applied',
        company: e.from.split(' <')[0],
        companyAsWritten: e.from.split(' <')[0],
        role: 'Engineer',
      })),
    },
  }))
}

const run = (action: typeof sync, tools: ActionTools, userId: string, params = {}) =>
  action({ userId, params, tools, env: {} as Env, callerJwt: 'jwt' })

describe('sync action (Gmail, fake tools)', () => {
  beforeEach(() => {
    generateObject.mockReset() // braces matter: a returned function would run as a cleanup hook
  })

  it('first sync pages through gmail-inbox with the filter and advances the cursor', async () => {
    modelLabelsAllApplied()
    const t = Date.UTC(2026, 10, 10)
    const { db, gmailCalls, tools } = fakeTools([
      { messages: [gmailMessage('g1', 'Acme', t), gmailMessage('g2', 'Acme', t + 1)], nextPageToken: 'p2' },
      { messages: [gmailMessage('g3', 'Bluefin', t + 2)] },
    ])
    const res = await run(sync, tools, 'alice', { source: 'gmail' })
    expect(res.success).toBe(true)
    expect(gmailCalls).toHaveLength(2)
    expect(String(gmailCalls[0].q).startsWith('newer_than:60d ')).toBe(true)
    expect(gmailCalls[1].pageToken).toBe('p2')
    const keys = [...db.applications.values()].map((r) => r.data.key).sort()
    expect(keys).toEqual(['acme|engineer', 'bluefin|engineer'])
    expect([...db.emails.values()].every((r) => r.data.userId === 'alice')).toBe(true)
    expect(db.syncState.get('alice')?.data.cursorAt).toBeTruthy()
  })

  it('two concurrent batches for the same company create one application', async () => {
    modelLabelsAllApplied()
    const t = Date.UTC(2026, 10, 10)
    const messages = Array.from({ length: 40 }, (_, i) => gmailMessage(`g${i}`, 'Acme', t + i))
    const { db, tools } = fakeTools([{ messages }])
    await run(sync, tools, 'alice', { source: 'gmail' })
    expect(db.applications.size).toBe(1)
    expect(db.emails.size).toBe(40)
  })

  it('does not advance the cursor when a batch fails', async () => {
    generateObject.mockRejectedValue(new Error('model down'))
    const { db, tools } = fakeTools([{ messages: [gmailMessage('g1', 'Acme', Date.UTC(2026, 10, 10))] }])
    const res = await run(sync, tools, 'alice', { source: 'gmail' })
    expect(res).toMatchObject({ success: true, data: { failedBatches: 1, classified: 0 } })
    expect(db.emails.size).toBe(0)
    expect(db.syncState.get('alice')?.data.cursorAt).toBeUndefined()
    expect(db.syncState.get('alice')?.data.lastSyncAt).toBeTruthy()
  })

  it('stores no sender, subject or snippet for a not-job-related email', async () => {
    generateObject.mockImplementation(async ({ prompt }: { prompt: string }) => ({
      object: {
        results: (JSON.parse(prompt).emails as Array<{ id: string }>).map((e) => ({
          id: e.id,
          label: 'not_job_related',
          company: '',
          companyAsWritten: '',
          role: '',
        })),
      },
    }))
    const { db, tools } = fakeTools([{ messages: [gmailMessage('g1', 'Acme', Date.UTC(2026, 10, 10))] }])
    await run(sync, tools, 'alice', { source: 'gmail' })
    const [row] = [...db.emails.values()]
    expect(row.data).toMatchObject({ userId: 'alice', gmailMessageId: 'g1', classification: 'not_job_related' })
    expect([row.data.from, row.data.subject, row.data.snippet].every((v) => !v)).toBe(true)
    expect(db.applications.size).toBe(0)
  })

  it('later syncs query from the stored cursor', async () => {
    modelLabelsAllApplied()
    const { db, gmailCalls, tools } = fakeTools([{ messages: [] }])
    const cursorAt = '2026-11-18T12:00:00.000Z'
    db.syncState.set('alice', {
      recordId: 'alice',
      data: { userId: 'alice', lastSyncAt: '2026-11-01T00:00:00.000Z', cursorAt },
    })
    await run(sync, tools, 'alice', { source: 'gmail' })
    expect(gmailCalls[0].q).toBe(buildGmailQuery(cursorAt))
  })
})

describe('sync action: app-wide daily caps, separate for demo and Gmail (fake tools)', () => {
  const T = Date.UTC(2026, 10, 20, 15) // 15:00 UTC, 9 hours before the next UTC day
  beforeEach(() => {
    generateObject.mockReset()
    vi.useFakeTimers({ now: T, toFake: ['Date'] })
    return () => {
      vi.useRealTimers()
    }
  })

  it(`takes the last of ${APP_DEMO_DAILY_LIMIT} app-wide demo slots`, async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools()
    fillTickets(db, 'sync-demo-2026-11-20', APP_DEMO_DAILY_LIMIT - 1)
    const res = await run(sync, tools, 'alice', { source: 'demo' })
    expect(res.success).toBe(true)
    expect(ticketsIn(db, 'sync-demo-2026-11-20')).toBe(APP_DEMO_DAILY_LIMIT)
    expect(ticketsIn(db, 'demo-user-alice-2026-11-20')).toBe(1)
    expect(generateObject).toHaveBeenCalled()
  })

  it('refuses every demo sync at the demo cap before any AI call, using nothing', async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools()
    fillTickets(db, 'sync-demo-2026-11-20', APP_DEMO_DAILY_LIMIT)
    const res = await run(sync, tools, 'alice', { source: 'demo' })
    expect(res).toMatchObject({
      success: false,
      code: 'app_limited',
      error: "Demo data has reached today's limit for everyone. Try again in about 9 hours.",
      details: { retryAfterSeconds: 9 * 3600 },
    })
    expect(generateObject).not.toHaveBeenCalled()
    expect(db.applications.size + db.emails.size).toBe(0)
    expect(ticketsIn(db, 'demo-user-alice-2026-11-20')).toBe(0)
  })

  it('a full demo cap does not block a Gmail sync (separate counters)', async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools([{ messages: [gmailMessage('g1', 'Acme', T - 1000)] }])
    fillTickets(db, 'sync-demo-2026-11-20', APP_DEMO_DAILY_LIMIT)
    expect((await run(sync, tools, 'alice', { source: 'gmail' })).success).toBe(true)
    expect(ticketsIn(db, 'sync-gmail-2026-11-20')).toBe(1)
  })

  it('refuses every Gmail sync at the Gmail cap, before the Gmail fetch', async () => {
    const { db, gmailCalls, tools } = fakeTools([{ messages: [gmailMessage('g1', 'Acme', T - 1000)] }])
    fillTickets(db, 'sync-gmail-2026-11-20', APP_GMAIL_DAILY_LIMIT)
    const res = await run(sync, tools, 'alice', { source: 'gmail' })
    expect(res).toMatchObject({ success: false, code: 'app_limited', error: "Gmail sync has reached today's limit for everyone. Try again in about 9 hours." })
    expect(gmailCalls).toHaveLength(0)
    expect(db.syncState.has('alice')).toBe(false)
  })

  it('starts fresh caps on the next UTC day', async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools()
    fillTickets(db, 'sync-demo-2026-11-19', APP_DEMO_DAILY_LIMIT)
    expect((await run(sync, tools, 'alice', { source: 'demo' })).success).toBe(true)
    expect(ticketsIn(db, 'sync-demo-2026-11-20')).toBe(1)
  })

  it('does not count a Gmail sync that stops at "connect Gmail first"', async () => {
    const { db, tools } = fakeTools([{ requiresOAuth: true, authUrl: 'https://consent.example' }])
    const res = await run(sync, tools, 'alice', { source: 'gmail' })
    expect(res).toMatchObject({ success: true, data: { requiresOAuth: true } })
    expect(db.usageTickets.size).toBe(0)
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('gives the user slot back when the app-wide cap fills between the check and the claim', async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools()
    // The early check sees a free slot; a parallel sync takes it before this one claims.
    const query = tools.query
    let calls = 0
    tools.query = (async (c: string, o: { where: Record<string, unknown> }) => {
      if (c === 'usageTickets' && o.where.scope === 'sync-demo-2026-11-20' && ++calls === 2) {
        fillTickets(db, 'sync-demo-2026-11-20', APP_DEMO_DAILY_LIMIT)
      }
      return query(c, o as never)
    }) as typeof tools.query
    const res = await run(sync, tools, 'alice', { source: 'demo' })
    expect(res).toMatchObject({ success: false, code: 'app_limited' })
    expect(ticketsIn(db, 'demo-user-alice-2026-11-20')).toBe(0) // released
    expect(generateObject).not.toHaveBeenCalled()
  })
})

describe('sync action: demo vs Gmail (fake tools)', () => {
  beforeEach(() => {
    generateObject.mockReset()
  })
  // The 402 the api-worker returns for a zero-credit account (seen locally,
  // 2026-11-20), after normalizeApiError.
  const credits402 = {
    __result: {
      success: false,
      error: 'Insufficient credits.',
      code: 'insufficient_credits',
      status: 402,
      details: { availableCredits: 0, requiredCredits: 1.3 },
    },
  }
  const demoCompanies = (db: ReturnType<typeof fakeTools>['db']) =>
    [...db.applications.values()].filter((r) => r.data.source === 'demo').map((r) => String(r.data.company))
  const promptCompanies = (call: unknown[]) =>
    (JSON.parse((call[0] as { prompt: string }).prompt).existingApplications as Array<{ company: string }>).map(
      (a) => a.company,
    )

  it('a demo sync right after another demo sync is not rate-limited, and never touches lastSyncAt', async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools()
    const ctx = { userId: 'alice', params: {}, tools, env: {} as Env, callerJwt: 'jwt' }
    expect((await run(sync, tools, 'alice', { source: 'demo' })).success).toBe(true)
    expect(db.applications.size).toBeGreaterThan(0)
    await clearDemoData(ctx)
    expect(db.applications.size + db.emails.size).toBe(0)
    const again = await run(sync, tools, 'alice', { source: 'demo' })
    expect(again.success).toBe(true)
    expect(db.applications.size).toBeGreaterThan(0)
    expect(db.syncState.get('alice')?.data.lastSyncAt).toBeUndefined()
    expect(db.usageTickets.size).toBe(4) // both count: per-user demo + app-wide demo, twice
  })

  it('a demo sync with nothing new costs no AI and counts nothing', async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools()
    await run(sync, tools, 'alice', { source: 'demo' })
    const calls = generateObject.mock.calls.length
    const res = await run(sync, tools, 'alice', { source: 'demo' })
    expect(res).toMatchObject({ success: true, data: { classified: 0, applicationsCreated: 0 } })
    expect(generateObject.mock.calls.length).toBe(calls)
    expect(db.usageTickets.size).toBe(2) // only the first sync's two tickets
  })

  it('an empty Gmail sync claims nothing and does not block a demo or another Gmail sync', async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools([{ messages: [], resultSizeEstimate: 0 }, { messages: [] }])
    const empty = await run(sync, tools, 'alice', { source: 'gmail' })
    expect(empty).toMatchObject({ success: true, data: { fetched: 0, applicationsCreated: 0 } })
    expect(db.syncState.get('alice')?.data.lastSyncAt).toBeUndefined()
    expect(db.syncState.get('alice')?.data.cursorAt).toBeTruthy() // the fetch was clean
    expect(db.usageTickets.size).toBe(0)
    expect((await run(sync, tools, 'alice', { source: 'gmail' })).success).toBe(true)
    expect((await run(sync, tools, 'alice', { source: 'demo' })).success).toBe(true)
  })

  it('a failed Gmail fetch is an error, not an empty inbox, and does not block a demo sync', async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools([{ __result: { success: false, error: 'Upstream error', status: 502 } }])
    const res = await run(sync, tools, 'alice', { source: 'gmail' })
    expect(res).toMatchObject({ success: false, error: 'Upstream error' })
    expect(db.syncState.has('alice')).toBe(false)
    expect(db.usageTickets.size).toBe(0)
    expect((await run(sync, tools, 'alice', { source: 'demo' })).success).toBe(true)
  })

  it('a 402 from gmail-inbox returns the credits message and claims nothing', async () => {
    const { db, tools } = fakeTools([credits402])
    const res = await run(sync, tools, 'alice', { source: 'gmail' })
    expect(res).toEqual({
      success: false,
      code: 'gmail_credits',
      error: 'Gmail sync needs DeepSpace credits on your account. Try demo data to see how applytrack works.',
    })
    expect(db.syncState.has('alice')).toBe(false)
    expect(db.usageTickets.size).toBe(0)
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('a 402 keeps the demo data; a successful Gmail sync removes it', async () => {
    modelLabelsAllApplied()
    const t = Date.UTC(2026, 10, 10)
    const { db, tools } = fakeTools([credits402, { messages: [gmailMessage('g1', 'Acme', t)] }])
    await run(sync, tools, 'alice', { source: 'demo' })
    const demoRows = db.applications.size
    await run(sync, tools, 'alice', { source: 'gmail' })
    expect(db.applications.size).toBe(demoRows)
    await run(sync, tools, 'alice', { source: 'gmail' })
    const rows = [...db.applications.values(), ...db.emails.values()]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.data.source === 'gmail')).toBe(true)
  })

  it("after demo then Gmail, no source:'demo' rows remain, and only the caller's were deleted", async () => {
    modelLabelsAllApplied()
    const t = Date.UTC(2026, 10, 10)
    const { db, tools } = fakeTools([{ messages: [gmailMessage('g1', 'Acme', t)] }])
    await run(sync, tools, 'bob', { source: 'demo' })
    await run(sync, tools, 'alice', { source: 'demo' })
    await run(sync, tools, 'alice', { source: 'gmail' })
    const alice = [...db.applications.values(), ...db.emails.values()].filter((r) => r.data.userId === 'alice')
    expect(alice.some((r) => r.data.source === 'demo')).toBe(false)
    expect(alice.some((r) => r.data.source === 'gmail')).toBe(true)
    expect([...db.applications.values()].some((r) => r.data.userId === 'bob' && r.data.source === 'demo')).toBe(true)
  })

  it('never passes demo company names to the classifier for a Gmail sync', async () => {
    modelLabelsAllApplied()
    const t = Date.UTC(2026, 10, 10)
    // Two Gmail batches, so the second call carries existing applications.
    const messages = Array.from({ length: 12 }, (_, i) => gmailMessage(`g${i}`, i < 6 ? 'Acme' : 'Bluefin', t + i))
    const { db, tools } = fakeTools([{ messages }])
    // Keep demo rows in place for this test, so the source filter itself is what's checked.
    const realDeleteWhere = tools.deleteWhere
    tools.deleteWhere = (async () => ({ success: true, data: { deleted: 0 } })) as typeof tools.deleteWhere
    await run(sync, tools, 'alice', { source: 'demo' })
    const names = demoCompanies(db)
    expect(names.length).toBeGreaterThan(0)
    const before = generateObject.mock.calls.length
    await run(sync, tools, 'alice', { source: 'gmail' })
    const gmailCalls = generateObject.mock.calls.slice(before)
    expect(gmailCalls.length).toBe(2)
    const seen = gmailCalls.flatMap(promptCompanies)
    expect(seen).toContain('Acme')
    for (const n of names) expect(seen).not.toContain(n)
    tools.deleteWhere = realDeleteWhere
  })
})

describe('sync action: per-user demo limit and Gmail-only users (fake tools)', () => {
  const T = Date.UTC(2026, 10, 21, 9)
  beforeEach(() => {
    generateObject.mockReset()
    vi.useFakeTimers({ now: T, toFake: ['Date'] })
    return () => {
      vi.useRealTimers()
    }
  })
  const ctx = (tools: ActionTools) => ({ userId: 'alice', params: {}, tools, env: {} as Env, callerJwt: 'jwt' })

  it(`allows ${DEMO_DAILY_LIMIT} demo syncs per UTC day, then refuses before any AI call`, async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools()
    for (let i = 1; i <= DEMO_DAILY_LIMIT; i++) {
      expect((await run(sync, tools, 'alice', { source: 'demo' })).success).toBe(true)
      await clearDemoData(ctx(tools))
    }
    expect(ticketsIn(db, 'demo-user-alice-2026-11-21')).toBe(DEMO_DAILY_LIMIT)
    const calls = generateObject.mock.calls.length
    vi.setSystemTime(T + 3 * 3600_000) // 12:00 UTC
    const res = await run(sync, tools, 'alice', { source: 'demo' })
    expect(res).toMatchObject({
      success: false,
      code: 'demo_limited',
      error: `You've loaded demo data ${DEMO_DAILY_LIMIT} times today. Try again in about 12 hours.`,
      details: { retryAfterSeconds: 12 * 3600 },
    })
    expect(generateObject.mock.calls.length).toBe(calls)
    expect(db.applications.size).toBe(0)
    expect(ticketsIn(db, 'sync-demo-2026-11-21')).toBe(DEMO_DAILY_LIMIT) // the refusal isn't counted
  })

  it('parallel demo syncs: exactly the limit get through to the AI', async () => {
    // A script firing many demo syncs at once (the counter race this replaced).
    const { db, tools } = fakeTools()
    generateObject.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5)) // keep the winners in flight together
      return { object: { results: [] } }
    })
    const results = await Promise.all(Array.from({ length: 20 }, () => run(sync, tools, 'alice', { source: 'demo' })))
    expect(results.filter((r) => r.success)).toHaveLength(DEMO_DAILY_LIMIT)
    expect(results.filter((r) => !r.success && (r as { code?: string }).code === 'demo_limited')).toHaveLength(20 - DEMO_DAILY_LIMIT)
    expect(ticketsIn(db, 'demo-user-alice-2026-11-21')).toBe(DEMO_DAILY_LIMIT)
    expect(ticketsIn(db, 'sync-demo-2026-11-21')).toBe(DEMO_DAILY_LIMIT)
  })

  it('parallel Gmail syncs: one per user per 10 minutes', async () => {
    modelLabelsAllApplied()
    const pages = Array.from({ length: 10 }, () => ({ messages: [gmailMessage('g1', 'Acme', T - 1000)] }))
    const { db, tools } = fakeTools(pages)
    const results = await Promise.all(Array.from({ length: 10 }, () => run(sync, tools, 'alice', { source: 'gmail' })))
    const passed = results.filter((r) => r.success)
    expect(passed).toHaveLength(1)
    expect(results.filter((r) => (r as { code?: string }).code === 'rate_limited')).toHaveLength(9)
    expect(ticketsIn(db, 'sync-gmail-2026-11-21')).toBe(1)
  })

  it('starts a new demo allowance on the next UTC day', async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools()
    fillTickets(db, 'demo-user-alice-2026-11-20', DEMO_DAILY_LIMIT)
    expect((await run(sync, tools, 'alice', { source: 'demo' })).success).toBe(true)
    expect(ticketsIn(db, 'demo-user-alice-2026-11-21')).toBe(1)
  })

  it('a demo sync with nothing new does not count toward the demo limit', async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools()
    await run(sync, tools, 'alice', { source: 'demo' })
    for (let i = 0; i < DEMO_DAILY_LIMIT + 2; i++) {
      expect((await run(sync, tools, 'alice', { source: 'demo' })).success).toBe(true)
    }
    expect(ticketsIn(db, 'demo-user-alice-2026-11-21')).toBe(1)
  })

  it('a Gmail sync is not limited by the demo count', async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools([{ messages: [gmailMessage('g1', 'Acme', T - 1000)] }])
    fillTickets(db, 'demo-user-alice-2026-11-21', DEMO_DAILY_LIMIT)
    expect((await run(sync, tools, 'alice', { source: 'gmail' })).success).toBe(true)
  })

  for (const [what, collection, row] of [
    ['a Gmail application', 'applications', { userId: 'alice', source: 'gmail', company: 'Acme', role: 'Engineer', key: 'acme|engineer', status: 'applied' }],
    ['only a not-job-related Gmail email', 'emails', { userId: 'alice', source: 'gmail', gmailMessageId: 'g9', classification: 'not_job_related' }],
  ] as const) {
    it(`refuses a demo sync when the user has ${what}, with no AI call and nothing counted`, async () => {
      modelLabelsAllApplied()
      const { db, tools } = fakeTools()
      db[collection].set('x1', { recordId: 'x1', data: { ...row } })
      const res = await run(sync, tools, 'alice', { source: 'demo' })
      expect(res).toEqual({
        success: false,
        code: 'demo_unavailable',
        error: "Demo data isn't available once you've synced Gmail, so demo and real applications never mix.",
      })
      expect(generateObject).not.toHaveBeenCalled()
      expect([...db.applications.values(), ...db.emails.values()].some((r) => r.data.source === 'demo')).toBe(false)
      expect(db.syncState.has('alice')).toBe(false)
      expect(db.usageTickets.size).toBe(0)
    })
  }

  it("another user's Gmail data does not block Alice's demo", async () => {
    modelLabelsAllApplied()
    const { db, tools } = fakeTools()
    db.emails.set('x1', { recordId: 'x1', data: { userId: 'bob', source: 'gmail', gmailMessageId: 'g9', classification: 'applied' } })
    expect((await run(sync, tools, 'alice', { source: 'demo' })).success).toBe(true)
  })
})

describe('deleteMyData action (fake tools)', () => {
  it('deletes only the caller rows and keeps the rate-limit timestamp', async () => {
    const { db, tools } = fakeTools()
    for (const user of ['alice', 'bob']) {
      db.emails.set(`e-${user}`, { recordId: `e-${user}`, data: { userId: user } })
      db.applications.set(`a-${user}`, { recordId: `a-${user}`, data: { userId: user } })
      db.syncState.set(user, { recordId: user, data: { userId: user, lastSyncAt: 'T', cursorAt: 'C' } })
    }
    const res = await run(deleteMyData, tools, 'alice', { userId: 'bob' }) // params are ignored
    expect(res).toEqual({ success: true, data: { deleted: { emails: 1, applications: 1 } } })
    expect([...db.emails.keys()]).toEqual(['e-bob'])
    expect([...db.applications.keys()]).toEqual(['a-bob'])
    expect(db.syncState.get('alice')?.data).toEqual({ userId: 'alice', lastSyncAt: 'T', cursorAt: null })
    expect(db.syncState.get('bob')?.data.cursorAt).toBe('C')
  })
})

// ---------------------------------------------------------------------------
// Accuracy: bodies, names, status rules
// ---------------------------------------------------------------------------

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('extractText', () => {
  it('prefers text/plain and drops quoted replies', () => {
    const text = 'Thanks for applying.\n\nWe chose another candidate.\n\nOn Mon, Nov 17, 2026 at 9:00 AM Jo <jo@x.example> wrote:\n> my old message'
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url(text) } },
        { mimeType: 'text/html', body: { data: b64url('<p>ignored</p>') } },
      ],
    }
    expect(extractText(payload)).toBe('Thanks for applying. We chose another candidate.')
  })

  it('strips HTML, styles and entities when there is no plain part', () => {
    const html = '<html><head><style>p{color:red}</style></head><body><p>Thank you&nbsp;&amp; welcome.</p><p>Paragraph&#39;s two</p></body></html>'
    expect(extractText({ mimeType: 'text/html', body: { data: b64url(html) } })).toBe("Thank you & welcome. Paragraph's two")
  })

  it('caps the text', () => {
    const long = 'word '.repeat(1000)
    expect(extractText({ mimeType: 'text/plain', body: { data: b64url(long) } }).length).toBe(1500)
  })
})

describe('cleanRole and keys', () => {
  it('drops job IDs, requisition IDs and trailing parentheticals', () => {
    expect(cleanRole('Software Engineer Intern (JOB ID: 38201)')).toBe('Software Engineer Intern')
    expect(cleanRole('Software Engineer - OVIP-334345')).toBe('Software Engineer')
    expect(cleanRole('Data Analyst, Req ID 7781')).toBe('Data Analyst')
    expect(cleanRole('2027 Technology Summer Internship')).toBe('2027 Technology Summer Internship') // years stay
    expect(cleanRole('(JOB ID: 1)')).toBe('Unspecified role')
    expect(normalizeKey('SICK', 'Engineer (JOB ID: 38201)')).toBe(normalizeKey('SICK AG Inc.'.replace(' AG', ''), 'Engineer'))
  })
})

describe('resolveCompany', () => {
  const known = new Map([['united wholesale mortgage', 'United Wholesale Mortgage']])
  it('maps initials onto an existing company, both ways', () => {
    expect(resolveCompany('UWM', known)).toEqual({ norm: 'united wholesale mortgage', display: 'United Wholesale Mortgage' })
    const acronymKnown = new Map([['uwm', 'UWM']])
    expect(resolveCompany('United Wholesale Mortgage', acronymKnown)).toEqual({ norm: 'uwm', display: 'UWM' })
  })
  it('leaves unrelated names alone', () => {
    expect(resolveCompany('Oracle', known)).toEqual({ norm: 'oracle', display: 'Oracle' })
    expect(resolveCompany('UW', known).norm).toBe('uw') // under 3 letters: no initials match
  })
})

describe('nextStatus', () => {
  const at = (d: number) => new Date(Date.UTC(2026, 10, d)).toISOString()
  it.each([
    ['applied', 'interview', 'interview'],
    ['interview', 'applied', 'interview'], // never backward
    ['offer', 'interview', 'offer'],
    ['interview', 'offer', 'offer'],
    ['applied', 'rejected', 'rejected'],
    ['interview', 'rejected', 'rejected'], // a later rejection always wins over interview
    ['rejected', 'interview', 'rejected'], // sync never moves a rejected card
    ['rejected', 'offer', 'rejected'],
  ])('%s + %s -> %s', (current, incoming, expected) => {
    expect(nextStatus(current, incoming, at(10), at(5))).toBe(expected)
  })
  it('a rejection older than an offer does not undo the offer; a newer one does', () => {
    expect(nextStatus('offer', 'rejected', at(3), at(5))).toBe('offer')
    expect(nextStatus('offer', 'rejected', at(9), at(5))).toBe('rejected')
  })
})

describe('validateBatch with existing names', () => {
  const uwm = { ...email('u', 'x', 1), from: 'UWM Recruiting <jobs@uwm.example>', subject: 'Interview', snippet: '' }
  it('accepts an existing canonical name when the email names the company another way', () => {
    const out = validateBatch(
      [uwm],
      { results: [{ id: 'u', label: 'interview', company: 'United Wholesale Mortgage', companyAsWritten: 'UWM', role: '' }] },
      emptyStats(),
      new Set(['united wholesale mortgage']),
    )!
    expect(out.get('u')).toMatchObject({ label: 'interview', company: 'United Wholesale Mortgage' })
  })

  it('falls back to the written name when the canonical one is not an existing company', () => {
    const out = validateBatch(
      [uwm],
      { results: [{ id: 'u', label: 'interview', company: 'Acme', companyAsWritten: 'UWM', role: '' }] },
      emptyStats(),
      new Set(['united wholesale mortgage']),
    )!
    expect(out.get('u')?.company).toBe('UWM')
  })

  it('rejects a written name the email does not contain, even if it is an existing company', () => {
    const stats = emptyStats()
    const out = validateBatch(
      [uwm],
      { results: [{ id: 'u', label: 'offer', company: 'Oracle', companyAsWritten: 'Oracle', role: '' }] },
      stats,
      new Set(['oracle']),
    )!
    expect(out.get('u')?.label).toBe('not_job_related')
    expect(stats.rejected.notGrounded).toBe(1)
  })

  it('grounds the company in the body, not only the snippet', () => {
    const e = { ...email('b', 'x', 1), from: 'Talent <t@ats.example>', subject: 'Update', snippet: 'Thanks', body: 'Thanks. Maple Ridge Software chose another candidate.' }
    const out = validateBatch([e], {
      results: [{ id: 'b', label: 'rejected', company: 'Maple Ridge Software', companyAsWritten: 'Maple Ridge Software', role: 'QA' }],
    })!
    expect(out.get('b')?.label).toBe('rejected')
  })
})

describe('sync action: names, roles and bodies (fake tools)', () => {
  beforeEach(() => {
    generateObject.mockReset()
  })

  // Model stub driven by a per-subject script: subject -> [label, company, written, role].
  function scriptModel(script: Record<string, [string, string, string, string]>) {
    const prompts: Array<{ existingApplications: unknown[]; emails: Array<{ text: string }> }> = []
    generateObject.mockImplementation(async ({ prompt }: { prompt: string }) => {
      const p = JSON.parse(prompt)
      prompts.push(p)
      return {
        object: {
          results: p.emails.map((e: { id: string; subject: string }) => {
            const [label, company, companyAsWritten, role] = script[e.subject]
            return { id: e.id, label, company, companyAsWritten, role }
          }),
        },
      }
    })
    return prompts
  }

  const msg = (id: string, from: string, subject: string, day: number, body = '') => ({
    id,
    snippet: subject,
    internalDate: String(Date.UTC(2026, 9, day)),
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }],
      body: body ? { data: b64url(body) } : {},
    },
  })

  it('merges UWM variants into one application, and a later rejection wins', async () => {
    const prompts = scriptModel({
      'Interview 1': ['interview', 'UWM', 'UWM', ''],
      'Interview 2': ['interview', 'United Wholesale Mortgage', 'United Wholesale Mortgage', '2027 Technology'],
      Decision: ['rejected', 'United Wholesale Mortgage', 'United Wholesale Mortgage', '2027 Technology'],
    })
    const { db, tools } = fakeTools([
      {
        messages: [
          msg('a', 'UWM <jobs@uwm.example>', 'Interview 1', 15),
          msg('b', 'United Wholesale Mortgage <jobs@uwm.example>', 'Interview 2', 21),
          msg('c', 'United Wholesale Mortgage <jobs@uwm.example>', 'Decision', 26),
        ],
      },
    ])
    await run(sync, tools, 'alice', { source: 'gmail' })
    const apps = [...db.applications.values()]
    expect(apps).toHaveLength(1)
    expect(apps[0].data).toMatchObject({ company: 'UWM', role: '2027 Technology', status: 'rejected' })
    expect(prompts).toHaveLength(1)
  })

  it('sends the cleaned body (not the snippet) and never stores it', async () => {
    const prompts = scriptModel({ 'Thank you for your application to Oracle': ['rejected', 'Oracle', 'Oracle', 'Engineer (JOB ID: 9912)'] })
    const body = 'Thank you for applying.\n\nThe hiring manager has chosen to move forward with another candidate.'
    const { db, tools } = fakeTools([{ messages: [msg('o', 'Oracle <x@oracle.example>', 'Thank you for your application to Oracle', 18, body)] }])
    await run(sync, tools, 'alice', { source: 'gmail' })
    expect(prompts[0].emails[0].text).toContain('another candidate')
    const [app] = [...db.applications.values()]
    expect(app.data).toMatchObject({ status: 'rejected', role: 'Engineer', key: 'oracle|engineer' })
    const [row] = [...db.emails.values()]
    expect(Object.values(row.data).join(' ')).not.toContain('another candidate')
  })

  it('passes existing applications into the next batch', async () => {
    const prompts = scriptModel({ s: ['applied', 'Acme', 'Acme', 'Engineer'] })
    const msgs = Array.from({ length: 11 }, (_, i) => msg(`m${i}`, 'Acme <x@acme.example>', 's', i + 1))
    const { tools } = fakeTools([{ messages: msgs }])
    await run(sync, tools, 'alice', { source: 'gmail' })
    expect(prompts).toHaveLength(2)
    expect(prompts[0].existingApplications).toEqual([])
    expect(prompts[1].existingApplications).toEqual([{ company: 'Acme', role: 'Engineer' }])
  })

  it('a card whose role was filled in keeps getting that role, in the same sync and in later syncs', async () => {
    scriptModel({
      'No role': ['applied', 'Acme', 'Acme', ''],
      'Named role': ['interview', 'Acme', 'Acme', 'Engineer'],
      'Same role again': ['interview', 'Acme', 'Acme', 'Engineer'],
      'Decision later': ['rejected', 'Acme', 'Acme', 'Engineer'],
    })
    const from = 'Acme <jobs@acme.example>'
    const { db, tools } = fakeTools([
      // Sync 1: unspecified card -> role filled in -> same role again.
      { messages: [msg('a', from, 'No role', 1), msg('b', from, 'Named role', 2), msg('c', from, 'Same role again', 3)] },
      // Sync 2 (fresh in-memory state, loaded from stored rows): same role once more.
      { messages: [msg('d', from, 'Decision later', 9)] },
    ])

    await run(sync, tools, 'alice', { source: 'gmail' })
    let apps = [...db.applications.values()]
    expect(apps).toHaveLength(1)
    // The key never changes; the stored role is filled in.
    expect(apps[0].data).toMatchObject({ key: 'acme|unspecified role', role: 'Engineer', status: 'interview' })

    // A later sync, past the 10-minute limit (the timestamp and its ticket).
    db.syncState.get('alice')!.data.lastSyncAt = '2000-01-01T00:00:00.000Z'
    for (const [k, r] of db.usageTickets) if (String(r.data.scope).startsWith('gmail-user-alice-')) db.usageTickets.delete(k)
    await run(sync, tools, 'alice', { source: 'gmail' })
    apps = [...db.applications.values()]
    expect(apps).toHaveLength(1)
    expect(apps[0].data.status).toBe('rejected')
    expect([...db.emails.values()].every((e) => e.data.applicationId === apps[0].recordId)).toBe(true)
  })
})

