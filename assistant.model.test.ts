/**
 * Real-model checks of the assistant (owner-billed, needs network). Skipped
 * unless RUN_MODEL_TESTS=1:
 *
 *   $env:RUN_MODEL_TESTS='1'; npx vitest run assistant.model.test.ts
 *
 * Uses the route's real settings and tools, with a fake record room holding
 * fictional data, and the API worker credentials from the generated .dev.vars.
 * Added after a live bug: replies were cut off mid-sentence (2026-11-19).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { streamDeepSpaceAgent } from 'deepspace/worker'
import { assistantStreamSettings } from './src/ai/chat-routes'
import { buildTools } from './src/ai/tools'
import { APP_ID } from './src/constants'

const RUN = process.env.RUN_MODEL_TESTS === '1'

/** Single-line KEY=value pairs from .dev.vars (values are never printed). */
function devVars(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '')
  }
  return out
}

// 30 fictional applications: 12 rejected, the rest spread over other statuses.
const REJECTED = [
  'Arbor Dynamics', 'Bright Harbor', 'Coastal Ledger', 'Delta Forge', 'Evergreen Labs', 'Foxglove Health',
  'Granite Peak', 'Helios Grid', 'Ironwood Motors', 'Juniper Freight', 'Kite Analytics', 'Lumen Retail',
]
const OTHERS = [
  'Meridian Bank', 'Nimbus Cloud', 'Orchid Media', 'Pinecrest Foods', 'Quarry Systems', 'Redwood Insurance',
  'Summit Robotics', 'Tidewater Energy', 'Umber Games', 'Vantage Aero', 'Willow Pharma', 'Xenon Chips',
  'Yarrow Logistics', 'Zephyr Mobility', 'Atlas Tooling', 'Beacon Learning', 'Cobalt Security', 'Drift Studios',
]
const apps = [
  ...REJECTED.map((company, i) => ({ company, role: i % 2 ? 'Software Engineer Intern' : 'Data Analyst', status: 'rejected' })),
  ...OTHERS.map((company, i) => ({ company, role: 'Backend Developer', status: ['applied', 'interview', 'applied', 'offer'][i % 4] })),
].map((a, i) => ({
  recordId: `app-${i}`,
  data: { userId: 'u', key: `k${i}`, ...a, lastActivityAt: new Date(Date.UTC(2026, 10, 1 + (i % 18))).toISOString() },
}))
const emails = apps.map((a, i) => ({
  recordId: `e${i}`,
  data: { userId: 'u', gmailMessageId: `m${i}`, classification: a.data.status, applicationId: a.recordId, receivedAt: a.data.lastActivityAt },
}))

const room = async (_tool: string, params: Record<string, unknown>) => ({
  success: true,
  data: { records: params.collection === 'applications' ? apps : params.collection === 'emails' ? emails : [] },
})

async function ask(question: string) {
  const vars = devVars()
  const env = {
    API_WORKER_URL: vars.API_WORKER_URL,
    APP_OWNER_JWT: vars.APP_OWNER_JWT,
    APP_IDENTITY_TOKEN: vars.APP_IDENTITY_TOKEN,
    DEEPSPACE_APP_ID: APP_ID,
  }
  const { result } = streamDeepSpaceAgent(env as never, {
    ...assistantStreamSettings(new Date('2026-11-20T12:00:00Z')),
    messages: [{ role: 'user', content: question }],
    tools: buildTools(room),
  })
  const [text, steps] = await Promise.all([result.text, result.steps])
  const perStep = steps.map((s) => ({
    finishReason: s.finishReason,
    tools: s.toolCalls.map((t) => t.toolName),
    outputTokens: s.usage.outputTokens,
    reasoningTokens: s.usage.outputTokenDetails?.reasoningTokens,
    textTokens: s.usage.outputTokenDetails?.textTokens,
    textChars: s.text.length,
    reasoningParts: s.content.filter((p) => p.type === 'reasoning').length,
    estTextTokens: Math.round(s.text.length / 4),
  }))
  console.log(`MODEL ${JSON.stringify({ question, perStep, words: text.split(/\s+/).filter(Boolean).length })}`)
  return { text, steps }
}

describe.skipIf(!RUN)('assistant against the real model', () => {
  it('lists all 12 rejected applications without being cut off', async () => {
    const { text, steps } = await ask('Which companies rejected me? List them all.')
    expect(steps.at(-1)?.finishReason).toBe('stop')
    for (const company of REJECTED) expect(text).toContain(company)
    expect(text).not.toContain('(reply shortened)')
  }, 120_000)

  // The question that thinks the most (up to ~1,370 of 1,500 tokens in testing).
  it('answers a follow-up question in full, thinking included', async () => {
    const { text, steps } = await ask(
      "Which companies haven't replied in 2 weeks, and which should I follow up with first? Explain briefly.",
    )
    expect(steps.at(-1)?.finishReason).toBe('stop')
    expect(text.split(/\s+/).filter(Boolean).length).toBeGreaterThan(40)
  }, 120_000)
})
