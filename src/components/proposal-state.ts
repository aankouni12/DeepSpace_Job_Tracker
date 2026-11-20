/**
 * Whether a status-change proposal card may still be confirmed.
 *
 * Browser-side only: the Confirm write is the board's normal status mutation,
 * so the server can't tell a stale click from the dropdown. The schema still
 * limits it to `status` on the user's own rows.
 */

export const PROPOSAL_TTL_MS = 10 * 60 * 1000

export type ProposalState = 'active' | 'superseded' | 'expired'

/**
 * @param proposedAt  this proposal's server timestamp (ISO); missing on proposals made before it existed
 * @param newestForApp the newest proposedAt among proposals for the same application in this chat
 */
export function proposalState(proposedAt: string | undefined, newestForApp: string | undefined, now: number): ProposalState {
  const at = Date.parse(proposedAt ?? '')
  if (!Number.isFinite(at)) return 'expired'
  const newest = Date.parse(newestForApp ?? '')
  if (Number.isFinite(newest) && newest > at) return 'superseded'
  return now - at >= PROPOSAL_TTL_MS ? 'expired' : 'active'
}

/** Newest proposedAt per applicationId, from a chat's message parts. */
export function newestProposals(messages: { parts?: unknown[] }[]): Map<string, string> {
  const newest = new Map<string, string>()
  for (const m of messages) {
    for (const part of m.parts ?? []) {
      const p = (part as { toolInvocation?: { toolName?: string; result?: { proposal?: { applicationId?: unknown; proposedAt?: unknown } } } })
        ?.toolInvocation
      if (p?.toolName !== 'propose_status_change') continue
      const { applicationId, proposedAt } = p.result?.proposal ?? {}
      if (typeof applicationId !== 'string' || typeof proposedAt !== 'string') continue
      const prev = newest.get(applicationId)
      if (!prev || Date.parse(proposedAt) > Date.parse(prev)) newest.set(applicationId, proposedAt)
    }
  }
  return newest
}
