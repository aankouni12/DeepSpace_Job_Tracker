import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import {
  buildGmailQuery,
  classifyAndWrite,
  deleteMyData,
  emptyStats,
  normalizeKey,
  parseGmailMessage,
  remapIds,
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
    )
    expect(maxClassifying).toBeGreaterThan(1)
    expect(maxInFlight).toBe(1)
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
  }
  const gmailCalls: Array<Record<string, unknown>> = []
  let n = 0
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => r.data[k] === v)
  const tools = {
    get: async (c: string, id: string) =>
      db[c].has(id) ? { success: true, data: { record: db[c].get(id) } } : { success: false, error: 'not found' },
    create: async (c: string, data: Record<string, unknown>, id?: string) => {
      const recordId = id ?? `r${++n}`
      db[c].set(recordId, { recordId, data: { ...data } })
      return { success: true, data: { recordId } }
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
      return { success: true, data: gmailPages.shift() ?? { messages: [], resultSizeEstimate: 0 } }
    },
  }
  return { db, gmailCalls, tools: tools as unknown as ActionTools }
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
      results: (JSON.parse(prompt) as Array<{ id: string; from: string }>).map((e) => ({
        id: e.id,
        label: 'applied',
        company: e.from.split(' <')[0],
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

