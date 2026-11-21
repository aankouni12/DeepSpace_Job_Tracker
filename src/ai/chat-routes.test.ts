/**
 * The assistant's cost controls: per-user and app-wide message limits, and the
 * real model settings (checked on the request the provider would send, with
 * the network replaced by a fake API_WORKER binding).
 */
import { describe, expect, it, vi } from 'vitest'
import { streamDeepSpaceAgent } from 'deepspace/worker'
import { fakeTicketTools } from '../server/usage-tickets.fake'
import {
  APP_DAILY_LIMIT,
  ASSISTANT_CONTEXT_CONFIG,
  ASSISTANT_MAX_OUTPUT_TOKENS,
  ASSISTANT_MAX_TOOL_CALLS,
  CHAT_DAILY_LIMIT,
  MAX_TITLE_LENGTH,
  SHORTENED_NOTE,
  assistantStreamSettings,
  claimChatMessage,
  clipTitle,
  limitMessage,
  markShortened,
} from './chat-routes'

const HOUR = 60 * 60 * 1000
const T0 = Date.parse('2026-11-19T12:00:00.000Z')

describe('claimChatMessage: per-user limit (atomic tickets)', () => {
  it(`allows ${CHAT_DAILY_LIMIT} messages per UTC day, then refuses until midnight UTC`, async () => {
    const { tools, count } = fakeTicketTools()
    for (let i = 1; i <= CHAT_DAILY_LIMIT; i++) {
      expect(await claimChatMessage(tools, 'alice', T0 + i * 1000)).toEqual({ ok: true })
    }
    const refused = await claimChatMessage(tools, 'alice', T0 + 2 * HOUR)
    expect(refused).toEqual({ ok: false, scope: 'user', retryAfterSeconds: 10 * 60 * 60 }) // 14:00 -> 00:00 UTC
    expect(count('assistant-user-alice-2026-11-19')).toBe(CHAT_DAILY_LIMIT)
    // A per-user refusal doesn't use up the app-wide budget.
    expect(count('assistant-app-2026-11-19')).toBe(CHAT_DAILY_LIMIT)
  })

  it('50 parallel messages from one user: exactly the limit get through', async () => {
    const { tools, count } = fakeTicketTools()
    const results = await Promise.all(Array.from({ length: 50 }, () => claimChatMessage(tools, 'alice', T0)))
    expect(results.filter((r) => r.ok)).toHaveLength(CHAT_DAILY_LIMIT)
    expect(results.filter((r) => !r.ok && r.scope === 'user')).toHaveLength(50 - CHAT_DAILY_LIMIT)
    expect(count('assistant-app-2026-11-19')).toBe(CHAT_DAILY_LIMIT)
  })

  it('starts a new allowance on the next UTC day, and counts users separately', async () => {
    const { tools, fill, count } = fakeTicketTools()
    fill('assistant-user-alice-2026-11-19', CHAT_DAILY_LIMIT)
    const midnight = Date.parse('2026-11-20T00:00:00.000Z')
    expect((await claimChatMessage(tools, 'alice', midnight - 1000)).ok).toBe(false)
    expect(await claimChatMessage(tools, 'bob', midnight - 1000)).toEqual({ ok: true })
    expect(await claimChatMessage(tools, 'alice', midnight)).toEqual({ ok: true })
    expect(count('assistant-user-alice-2026-11-20')).toBe(1)
  })
})

describe('claimChatMessage: app-wide limit (atomic tickets)', () => {
  it(`refuses everyone at ${APP_DAILY_LIMIT} messages per UTC day, giving the user slot back`, async () => {
    const { tools, fill, count } = fakeTicketTools()
    fill('assistant-app-2026-11-19', APP_DAILY_LIMIT - 1)
    expect(await claimChatMessage(tools, 'alice', T0)).toEqual({ ok: true })
    const refused = await claimChatMessage(tools, 'bob', T0)
    expect(refused).toEqual({ ok: false, scope: 'app', retryAfterSeconds: 12 * 60 * 60 }) // until 00:00 UTC
    expect(count('assistant-user-bob-2026-11-19')).toBe(0) // released
    expect(count('assistant-app-2026-11-19')).toBe(APP_DAILY_LIMIT)
  })

  it('parallel messages from many users never pass the app-wide limit', async () => {
    const { tools, fill, count } = fakeTicketTools()
    fill('assistant-app-2026-11-19', APP_DAILY_LIMIT - 5)
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => claimChatMessage(tools, `u${i}`, T0)))
    expect(results.filter((r) => r.ok)).toHaveLength(5)
    expect(count('assistant-app-2026-11-19')).toBe(APP_DAILY_LIMIT)
    // Every refused user got their slot back.
    for (let i = 0; i < 40; i++) expect(count(`assistant-user-u${i}-2026-11-19`)).toBeLessThanOrEqual(1)
    const userSlots = Array.from({ length: 40 }, (_, i) => count(`assistant-user-u${i}-2026-11-19`)).reduce((a, b) => a + b, 0)
    expect(userSlots).toBe(5)
  })

  it('starts a fresh allowance on the next UTC day', async () => {
    const { tools, fill, count } = fakeTicketTools()
    fill('assistant-app-2026-11-19', APP_DAILY_LIMIT)
    const midnight = Date.parse('2026-11-20T00:00:00.000Z')
    expect((await claimChatMessage(tools, 'alice', midnight - 1000)).ok).toBe(false)
    expect(await claimChatMessage(tools, 'alice', midnight)).toEqual({ ok: true })
    expect(count('assistant-app-2026-11-20')).toBe(1)
  })

  it('clips client-supplied chat titles to 100 characters', () => {
    expect(MAX_TITLE_LENGTH).toBe(100)
    expect(clipTitle('x'.repeat(100_000))).toHaveLength(100)
    expect(clipTitle('My search')).toBe('My search')
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
  it('sends the 2,000-token output cap, Haiku, and owner billing to the model', async () => {
    const { url, body, headers } = await runAssistant('ok')
    expect(url).toContain('/api/proxy/anthropic/v1/messages')
    expect(body.model).toBe('claude-haiku-5-5')
    expect(body.max_tokens).toBe(ASSISTANT_MAX_OUTPUT_TOKENS)
    expect(ASSISTANT_MAX_OUTPUT_TOKENS).toBe(2000)
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
})

describe('markShortened: "(reply shortened)" instead of a sentence that just stops', () => {
  async function through(parts: Array<{ type: string } & Record<string, unknown>>) {
    const out: Record<string, unknown>[] = []
    const source = new ReadableStream<{ type: string }>({
      start: (c) => {
        parts.forEach((p) => c.enqueue(p))
        c.close()
      },
    })
    const stream = markShortened(source)
    for await (const part of stream as unknown as AsyncIterable<Record<string, unknown>>) out.push(part)
    return out
  }
  const step = (finishReason: string) => [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', text: 'A p' },
    { type: 'text-end', id: 't' },
    { type: 'finish-step', finishReason },
    { type: 'finish', finishReason },
  ]

  it('adds the note before the finish-step of a step cut off by the cap', async () => {
    const out = await through(step('length'))
    expect(out.map((p) => p.type)).toEqual([
      'text-start', 'text-delta', 'text-end', 'text-start', 'text-delta', 'text-end', 'finish-step', 'finish',
    ])
    expect(out[4]).toMatchObject({ type: 'text-delta', text: `\n\n${SHORTENED_NOTE}` })
  })

  it('leaves a reply that finished normally unchanged', async () => {
    const parts = step('stop')
    expect(await through(parts)).toEqual(parts)
  })
})

describe('the shortened note reaches the client as text (real SDK call, fake network)', () => {
  it('shows "(reply shortened)" when the model stops at max_tokens', async () => {
    const fetchFn = vi.fn(async () => new Response(anthropicReply('A p', 'max_tokens'), { headers: { 'Content-Type': 'text/event-stream' } }))
    const env = { API_WORKER: { fetch: fetchFn }, APP_OWNER_JWT: 'owner-jwt', DEEPSPACE_APP_ID: 'app-test' }
    const { result } = streamDeepSpaceAgent(env as never, {
      ...assistantStreamSettings(new Date(T0)),
      messages: [{ role: 'user', content: 'hi' }],
    })
    let text = ''
    for await (const part of markShortened(result.stream as unknown as ReadableStream<{ type: string }>) as unknown as AsyncIterable<{ type: string; text?: string }>) {
      if (part.type === 'text-delta') text += part.text
    }
    expect(text).toBe(`A p\n\n${SHORTENED_NOTE}`)
  })

  it('uses 4 tool calls and a 30,000-character history budget', () => {
    expect(ASSISTANT_MAX_TOOL_CALLS).toBe(4)
    expect(assistantStreamSettings(new Date(T0)).maxToolCalls).toBe(4)
    expect(ASSISTANT_CONTEXT_CONFIG.contextBudget).toBe(30_000)
  })
})
