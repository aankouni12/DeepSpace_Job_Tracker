/**
 * The assistant's per-user message limit (owner-billed AI).
 */
import { describe, expect, it } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import { CHAT_DAILY_LIMIT, claimChatMessage } from './chat-routes'

const HOUR = 60 * 60 * 1000
const T0 = Date.parse('2026-11-19T12:00:00.000Z')

/** In-memory syncState, keyed by record id (= userId), like the action tools. */
function fakeTools(initial: Record<string, Record<string, unknown>> = {}) {
  const rows = new Map(Object.entries(initial))
  const tools = {
    get: async (_c: string, id: string) =>
      rows.has(id)
        ? { success: true, data: { record: { recordId: id, data: rows.get(id) } } }
        : { success: false, error: 'not found' },
    update: async (_c: string, id: string, data: Record<string, unknown>) => {
      rows.set(id, { ...rows.get(id), ...data })
      return { success: true, data: {} }
    },
    create: async (_c: string, data: Record<string, unknown>, id: string) => {
      rows.set(id, data)
      return { success: true, data: {} }
    },
  } as unknown as ActionTools
  return { tools, rows }
}

describe('claimChatMessage', () => {
  it(`allows ${CHAT_DAILY_LIMIT} messages, then refuses with a retry time`, async () => {
    const { tools, rows } = fakeTools()
    for (let i = 1; i <= CHAT_DAILY_LIMIT; i++) {
      expect(await claimChatMessage(tools, 'alice', T0 + i * 1000)).toEqual({ ok: true })
    }
    expect(rows.get('alice')).toMatchObject({ userId: 'alice', chatCount: CHAT_DAILY_LIMIT })
    const refused = await claimChatMessage(tools, 'alice', T0 + 2 * HOUR)
    // The window opened at the first message (T0 + 1 s), so it reopens at T0 + 24 h + 1 s.
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 22 * 60 * 60 + 1 })
    expect(rows.get('alice')?.chatCount).toBe(CHAT_DAILY_LIMIT) // a refusal doesn't count
  })

  it('starts a new window 24 hours after the first message', async () => {
    const { tools, rows } = fakeTools({
      alice: { userId: 'alice', chatWindowStart: new Date(T0).toISOString(), chatCount: CHAT_DAILY_LIMIT },
    })
    expect((await claimChatMessage(tools, 'alice', T0 + 24 * HOUR - 1000)).ok).toBe(false)
    expect(await claimChatMessage(tools, 'alice', T0 + 24 * HOUR)).toEqual({ ok: true })
    expect(rows.get('alice')).toMatchObject({ chatCount: 1, chatWindowStart: new Date(T0 + 24 * HOUR).toISOString() })
  })

  it("keeps sync's fields on an existing row, and counts users separately", async () => {
    const { tools, rows } = fakeTools({ alice: { userId: 'alice', lastSyncAt: 'x', cursorAt: 'y' } })
    await claimChatMessage(tools, 'alice', T0)
    await claimChatMessage(tools, 'bob', T0)
    expect(rows.get('alice')).toMatchObject({ lastSyncAt: 'x', cursorAt: 'y', chatCount: 1 })
    expect(rows.get('bob')).toMatchObject({ userId: 'bob', chatCount: 1 })
  })
})
