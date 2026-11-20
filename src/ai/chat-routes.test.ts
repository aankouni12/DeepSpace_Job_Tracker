/**
 * The assistant's cost controls: per-user and app-wide message limits, and the
 * real model settings (checked on the request the provider would send, with
 * the network replaced by a fake API_WORKER binding).
 */
import { describe, expect, it, vi } from 'vitest'
import { streamDeepSpaceAgent } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import {
  APP_DAILY_LIMIT,
  ASSISTANT_CONTEXT_CONFIG,
  ASSISTANT_MAX_OUTPUT_TOKENS,
  ASSISTANT_MAX_TOOL_CALLS,
  CHAT_DAILY_LIMIT,
  assistantStreamSettings,
  claimChatMessage,
  limitMessage,
} from './chat-routes'

const HOUR = 60 * 60 * 1000
const T0 = Date.parse('2026-11-19T12:00:00.000Z')

/** In-memory syncState + appUsage, keyed by record id, like the action tools. */
function fakeTools(initial: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const db: Record<string, Map<string, Record<string, unknown>>> = {
    syncState: new Map(Object.entries(initial.syncState ?? {})),
    appUsage: new Map(Object.entries(initial.appUsage ?? {})),
  }
  const tools = {
    get: async (c: string, id: string) =>
      db[c].has(id)
        ? { success: true, data: { record: { recordId: id, data: db[c].get(id) } } }
        : { success: false, error: 'not found' },
    update: async (c: string, id: string, data: Record<string, unknown>) => {
      db[c].set(id, { ...db[c].get(id), ...data })
      return { success: true, data: {} }
    },
    create: async (c: string, data: Record<string, unknown>, id: string) => {
      db[c].set(id, data)
      return { success: true, data: {} }
    },
  } as unknown as ActionTools
  return { tools, db }
}

describe('claimChatMessage: per-user limit', () => {
  it(`allows ${CHAT_DAILY_LIMIT} messages, then refuses with a retry time`, async () => {
    const { tools, db } = fakeTools()
    for (let i = 1; i <= CHAT_DAILY_LIMIT; i++) {
      expect(await claimChatMessage(tools, 'alice', T0 + i * 1000)).toEqual({ ok: true })
    }
    expect(db.syncState.get('alice')).toMatchObject({ userId: 'alice', chatCount: CHAT_DAILY_LIMIT })
    const refused = await claimChatMessage(tools, 'alice', T0 + 2 * HOUR)
    // The window opened at the first message (T0 + 1 s), so it reopens at T0 + 24 h + 1 s.
    expect(refused).toEqual({ ok: false, scope: 'user', retryAfterSeconds: 22 * 60 * 60 + 1 })
    expect(db.syncState.get('alice')?.chatCount).toBe(CHAT_DAILY_LIMIT)
    // A per-user refusal doesn't use up the app-wide budget.
    expect(db.appUsage.get('assistant-2026-11-19')?.assistantMessages).toBe(CHAT_DAILY_LIMIT)
  })

  it('starts a new window 24 hours after the first message', async () => {
    const { tools, db } = fakeTools({
      syncState: { alice: { userId: 'alice', chatWindowStart: new Date(T0).toISOString(), chatCount: CHAT_DAILY_LIMIT } },
    })
    expect((await claimChatMessage(tools, 'alice', T0 + 24 * HOUR - 1000)).ok).toBe(false)
    expect(await claimChatMessage(tools, 'alice', T0 + 24 * HOUR)).toEqual({ ok: true })
    expect(db.syncState.get('alice')).toMatchObject({ chatCount: 1, chatWindowStart: new Date(T0 + 24 * HOUR).toISOString() })
  })

  it("keeps sync's fields on an existing row, and counts users separately", async () => {
    const { tools, db } = fakeTools({ syncState: { alice: { userId: 'alice', lastSyncAt: 'x', cursorAt: 'y' } } })
    await claimChatMessage(tools, 'alice', T0)
    await claimChatMessage(tools, 'bob', T0)
    expect(db.syncState.get('alice')).toMatchObject({ lastSyncAt: 'x', cursorAt: 'y', chatCount: 1 })
    expect(db.syncState.get('bob')).toMatchObject({ userId: 'bob', chatCount: 1 })
    expect(db.appUsage.get('assistant-2026-11-19')).toEqual({ day: '2026-11-19', assistantMessages: 2 })
  })
})

describe('claimChatMessage: app-wide limit', () => {
  it(`refuses everyone at ${APP_DAILY_LIMIT} messages per UTC day, without counting the user`, async () => {
    const { tools, db } = fakeTools({
      appUsage: { 'assistant-2026-11-19': { day: '2026-11-19', assistantMessages: APP_DAILY_LIMIT - 1 } },
    })
    expect(await claimChatMessage(tools, 'alice', T0)).toEqual({ ok: true })
    const refused = await claimChatMessage(tools, 'bob', T0)
    expect(refused).toEqual({ ok: false, scope: 'app', retryAfterSeconds: 12 * 60 * 60 }) // until 00:00 UTC
    expect(db.syncState.has('bob')).toBe(false)
    expect(db.appUsage.get('assistant-2026-11-19')?.assistantMessages).toBe(APP_DAILY_LIMIT)
  })

  it('starts a fresh counter on the next UTC day', async () => {
    const { tools, db } = fakeTools({
      appUsage: { 'assistant-2026-11-19': { day: '2026-11-19', assistantMessages: APP_DAILY_LIMIT } },
    })
    const midnight = Date.parse('2026-11-20T00:00:00.000Z')
    expect((await claimChatMessage(tools, 'alice', midnight - 1000)).ok).toBe(false)
    expect(await claimChatMessage(tools, 'alice', midnight)).toEqual({ ok: true })
    expect(db.appUsage.get('assistant-2026-11-20')).toEqual({ day: '2026-11-20', assistantMessages: 1 })
  })

  it('tells users which limit they hit', () => {
    expect(limitMessage({ ok: false, scope: 'app', retryAfterSeconds: 3 * HOUR / 1000 })).toBe(
      "The assistant has reached today's limit for everyone. Try again in about 3 hours.",
    )
    expect(limitMessage({ ok: false, scope: 'user', retryAfterSeconds: 60 })).toBe(
      `You've used all ${CHAT_DAILY_LIMIT} assistant messages for today. Try again in about 1 hour.`,
    )
  })
})

// ---------------------------------------------------------------------------
// Model settings, through the real SDK call with a fake network
// ---------------------------------------------------------------------------

const sse = (events: object[]) =>
  events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

/** A canned Anthropic Messages stream (what a mocked model "says"). */
function anthropicReply(text: string, stopReason = 'end_turn') {
  return sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ])
}

async function runAssistant(reply: string, stopReason?: string) {
  const fetchFn = vi.fn(async () => new Response(anthropicReply(reply, stopReason), { headers: { 'Content-Type': 'text/event-stream' } }))
  const env = { API_WORKER: { fetch: fetchFn }, APP_OWNER_JWT: 'owner-jwt', DEEPSPACE_APP_ID: 'app-test' }
  const { result } = streamDeepSpaceAgent(env as never, {
    ...assistantStreamSettings(new Date(T0)),
    messages: [{ role: 'user', content: 'What is a linked list?' }],
  })
  const text = await result.text
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  return { text, url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) }
}

describe('assistant model settings (real SDK call, fake network)', () => {
  it('sends the 500-token output cap, Haiku, and owner billing to the model', async () => {
    const { url, body, headers } = await runAssistant('ok')
    expect(url).toContain('/api/proxy/anthropic/v1/messages')
    expect(body.model).toBe('claude-haiku-5-5')
    expect(body.max_tokens).toBe(ASSISTANT_MAX_OUTPUT_TOKENS)
    expect(ASSISTANT_MAX_OUTPUT_TOKENS).toBe(500)
    // The proxy bills the X-Auth-Token subject: the owner's JWT, not the caller's.
    expect(headers.get('x-auth-token')).toBe('owner-jwt')
  })

  it('sends the scope rule, and passes a scope refusal through to the user (model mocked)', async () => {
    const refusal = 'I can only help with your job applications.'
    const { text, body } = await runAssistant(refusal)
    const system = JSON.stringify(body.system)
    expect(system).toContain("you only help with the user's job applications and job search")
    expect(system).toContain('general knowledge, coding or homework')
    expect(text).toBe(refusal)
  })

  it('a reply cut off at the cap still ends the turn cleanly', async () => {
    const { text } = await runAssistant('Partial answer', 'max_tokens')
    expect(text).toBe('Partial answer')
  })

  it('uses 4 tool calls and a 30,000-character history budget', () => {
    expect(ASSISTANT_MAX_TOOL_CALLS).toBe(4)
    expect(assistantStreamSettings(new Date(T0)).maxToolCalls).toBe(4)
    expect(ASSISTANT_CONTEXT_CONFIG.contextBudget).toBe(30_000)
  })
})
