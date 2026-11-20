import { describe, expect, it } from 'vitest'
import { PROPOSAL_TTL_MS, newestProposals, proposalState } from './proposal-state'

const T = Date.parse('2026-11-19T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('proposalState', () => {
  it('is active when it is the newest for its application and under 10 minutes old', () => {
    expect(proposalState(iso(T), iso(T), T + PROPOSAL_TTL_MS - 1)).toBe('active')
  })

  it('is superseded when a newer proposal exists for the same application', () => {
    expect(proposalState(iso(T), iso(T + 1000), T + 2000)).toBe('superseded')
  })

  it('expires after 10 minutes', () => {
    expect(proposalState(iso(T), iso(T), T + PROPOSAL_TTL_MS)).toBe('expired')
  })

  it('treats a proposal with no timestamp (made before this change) as expired', () => {
    expect(proposalState(undefined, undefined, T)).toBe('expired')
  })
})

describe('newestProposals', () => {
  const part = (applicationId: string, proposedAt?: string, toolName = 'propose_status_change') => ({
    type: 'tool-invocation',
    toolCallId: `${applicationId}-${proposedAt}`,
    toolInvocation: { toolName, state: 'result', result: { proposal: { applicationId, proposedAt } } },
  })

  it('keeps the newest proposedAt per application, across messages', () => {
    const newest = newestProposals([
      { parts: [part('a', iso(T)), part('b', iso(T + 5))] },
      { parts: [part('a', iso(T + 10)), { type: 'text', text: 'hi' }] },
      { parts: [part('a', iso(T + 3))] },
      {},
    ])
    expect(Object.fromEntries(newest)).toEqual({ a: iso(T + 10), b: iso(T + 5) })
  })

  it('ignores other tools and proposals without a timestamp', () => {
    const newest = newestProposals([{ parts: [part('a'), part('b', iso(T), 'list_applications')] }])
    expect(newest.size).toBe(0)
  })
})
