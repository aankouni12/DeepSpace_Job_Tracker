/**
 * Atomic usage limits for owner-billed work, shared by the sync action and the
 * assistant's chat route. See src/schemas/usage-tickets-schema.ts for why a
 * ticket per use (unique on scope + slot) instead of a counter.
 *
 * `tools` must be the server's RBAC-off action tools; every scope is built by
 * the caller from the verified userId and the server clock, never from input.
 */

import type { ActionTools } from 'deepspace/worker'

const TICKETS = 'usageTickets'
export const DAY_MS = 86_400_000

export type Ticket = { recordId: string }

/** The UTC day of `now`, e.g. "2026-11-21". */
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)

/** Seconds until the next UTC midnight. */
export const secondsToNextUtcDay = (now: number) =>
  Math.ceil((Date.parse(`${utcDay(now)}T00:00:00.000Z`) + DAY_MS - now) / 1000)

async function takenSlots(tools: ActionTools, scope: string, limit: number): Promise<Set<number>> {
  const res = await tools.query<{ n: number }>(TICKETS, { where: { scope }, limit })
  if (!res.success) throw new Error(`query ${TICKETS} failed: ${res.error}`)
  return new Set(res.data.records.map((r) => r.data.n))
}

/**
 * Advisory only (not atomic): true when every slot in `scope` is taken. Used
 * to refuse early, before paid work such as a Gmail fetch; claimTicket is
 * what actually enforces the limit.
 */
export async function isFull(tools: ActionTools, scope: string, limit: number): Promise<boolean> {
  return (await takenSlots(tools, scope, limit)).size >= limit
}

/**
 * Claim one of slots 1..limit in `scope`, or return null when all are taken.
 * Exactly one create per slot can succeed; a "Duplicate" means a parallel
 * request just took that slot, so try the next. At most `limit` creates.
 */
export async function claimTicket(tools: ActionTools, scope: string, limit: number): Promise<Ticket | null> {
  const taken = await takenSlots(tools, scope, limit)
  for (let n = 1; n <= limit; n++) {
    if (taken.has(n)) continue
    const res = await tools.create(TICKETS, { scope, n })
    if (res.success) return { recordId: res.data.recordId }
    if (!String(res.error).startsWith('Duplicate')) throw new Error(`claim ${scope} failed: ${res.error}`)
  }
  return null
}

/** Give a slot back (a later check refused the work it was claimed for). */
export async function releaseTicket(tools: ActionTools, ticket: Ticket): Promise<void> {
  const res = await tools.remove(TICKETS, ticket.recordId)
  if (!res.success) throw new Error(`release ticket failed: ${res.error}`)
}
