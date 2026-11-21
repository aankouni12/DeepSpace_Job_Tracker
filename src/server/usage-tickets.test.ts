/**
 * Atomic usage limits, against a fake of the RecordRoom behaviour the
 * tickets rely on (see usage-tickets.fake.ts).
 */
import { describe, expect, it } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import { usageTicketsSchema } from '../schemas/usage-tickets-schema'
import { fakeTicketTools } from './usage-tickets.fake'
import { claimTicket, isFull, releaseTicket, secondsToNextUtcDay, utcDay } from './usage-tickets'

describe('usageTickets schema', () => {
  it('is unique on (scope, n) and closed to every role', () => {
    expect(usageTicketsSchema.uniqueOn).toEqual(['scope', 'n'])
    for (const role of ['*', 'viewer', 'member', 'admin'] as const) {
      expect(usageTicketsSchema.permissions[role]).toEqual({ read: false, create: false, update: false, delete: false })
    }
  })
})

describe('claimTicket', () => {
  it('20 parallel claims against a limit of 5: exactly 5 succeed', async () => {
    const { rows, tools } = fakeTicketTools()
    const results = await Promise.all(Array.from({ length: 20 }, () => claimTicket(tools, 'demo-user-alice-2026-11-21', 5)))
    expect(results.filter(Boolean)).toHaveLength(5)
    expect([...rows.values()].map((r) => r.n).sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('50 parallel claims against a limit of 30 across two scopes stay separate', async () => {
    const { tools } = fakeTicketTools()
    const claims = Array.from({ length: 50 }, (_, i) => claimTicket(tools, `assistant-user-${i % 2 ? 'a' : 'b'}-2026-11-21`, 30))
    expect((await Promise.all(claims)).filter(Boolean)).toHaveLength(50) // 25 per scope, both under 30
    const more = await Promise.all(Array.from({ length: 20 }, () => claimTicket(tools, 'assistant-user-a-2026-11-21', 30)))
    expect(more.filter(Boolean)).toHaveLength(5) // a had 25; only 5 slots left
  })

  it('a released slot can be claimed again; isFull reflects it', async () => {
    const { tools } = fakeTicketTools()
    const tickets = await Promise.all([1, 2].map(() => claimTicket(tools, 's', 2)))
    expect(await isFull(tools, 's', 2)).toBe(true)
    expect(await claimTicket(tools, 's', 2)).toBeNull()
    await releaseTicket(tools, tickets[0]!)
    expect(await isFull(tools, 's', 2)).toBe(false)
    expect(await claimTicket(tools, 's', 2)).not.toBeNull()
  })

  it('throws on any create error other than a duplicate (never silently passes)', async () => {
    const { tools } = fakeTicketTools()
    ;(tools as unknown as { create: unknown }).create = async () => ({ success: false, error: 'CREATE DENIED' })
    await expect(claimTicket(tools, 's', 3)).rejects.toThrow('CREATE DENIED')
  })

  it('UTC day helpers', () => {
    const t = Date.parse('2026-11-21T15:00:00.000Z')
    expect(utcDay(t)).toBe('2026-11-21')
    expect(secondsToNextUtcDay(t)).toBe(9 * 3600)
  })
})
