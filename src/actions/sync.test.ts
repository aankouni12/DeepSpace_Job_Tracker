import { describe, expect, it } from 'vitest'
import {
  classifyAndWrite,
  normalizeKey,
  parseGmailMessage,
  validateBatch,
  type Classified,
  type InboxEmail,
} from './sync'

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

describe('classifyAndWrite', () => {
  // 12 emails -> batches of 10 and 2, processed oldest first.
  const emails = Array.from({ length: 12 }, (_, i) => email(`m${i}`, `Acme ${i}`, 12 - i))

  it('writes nothing for a failed batch and still writes later batches', async () => {
    const written: string[] = []
    let call = 0
    const result = await classifyAndWrite(
      emails,
      async (batch) => {
        call++
        if (call === 1) return null // whole AI call failed
        return { results: batch.map((e) => ({ id: e.id, label: 'applied', company: 'Acme', role: 'r' })) }
      },
      async (e) => {
        written.push(e.id)
      },
    )
    expect(result).toEqual({ classified: 2, failedBatches: 1 })
    expect(written).toEqual(['m1', 'm0']) // only the second (newest) batch
  })

  it('treats unparseable output as a failed batch', async () => {
    const written: string[] = []
    const result = await classifyAndWrite(
      emails.slice(0, 3),
      async () => ({ unexpected: true }),
      async (e) => {
        written.push(e.id)
      },
    )
    expect(result).toEqual({ classified: 0, failedBatches: 1 })
    expect(written).toEqual([])
  })

  it('writes oldest first with per-item fallback', async () => {
    const seen: Array<[string, Classified['label']]> = []
    await classifyAndWrite(
      [email('new', 'Acme', 9), email('old', 'Acme', 1)],
      async () => ({ results: [{ id: 'new', label: 'offer', company: 'Acme', role: 'r' }] }),
      async (e, c) => {
        seen.push([e.id, c.label])
      },
    )
    expect(seen).toEqual([
      ['old', 'not_job_related'],
      ['new', 'offer'],
    ])
  })
})
