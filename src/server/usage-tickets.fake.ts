/**
 * Test-only fake of the action tools for usageTickets, modelling the
 * RecordRoom behaviour the tickets rely on (deepspace 0.44.x putRecord):
 * every call first yields, so parallel claims interleave like concurrent
 * requests; a create that breaks `uniqueOn: ['scope', 'n']` fails with
 * "Duplicate" in the same synchronous step as the insert; and a create with
 * an existing recordId updates that row instead of failing.
 */
import type { ActionTools } from 'deepspace/worker'

type Row = { scope: string; n: number }

export function fakeTicketTools() {
  const rows = new Map<string, Row>()
  let id = 0
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const tools = {
    query: async (_c: string, { where, limit }: { where: { scope: string }; limit: number }) => {
      await tick()
      const records = [...rows.entries()]
        .filter(([, r]) => r.scope === where.scope)
        .slice(0, limit)
        .map(([recordId, data]) => ({ recordId, data }))
      return { success: true, data: { records } }
    },
    create: async (_c: string, data: Row, recordId?: string) => {
      await tick()
      // Synchronous from here, like putRecord inside the Durable Object.
      if (recordId && rows.has(recordId)) {
        rows.set(recordId, { ...rows.get(recordId)!, ...data }) // the SDK upserts
        return { success: true, data: { recordId } }
      }
      for (const r of rows.values()) {
        if (r.scope === data.scope && r.n === data.n) {
          return { success: false, error: `Duplicate: a record with scope=${data.scope}, n=${data.n} already exists in usageTickets` }
        }
      }
      const newId = recordId ?? `t${++id}`
      rows.set(newId, { ...data })
      return { success: true, data: { recordId: newId } }
    },
    remove: async (_c: string, recordId: string) => {
      await tick()
      rows.delete(recordId)
      return { success: true, data: {} }
    },
  }
  /** Slots taken in a scope. */
  const count = (scope: string) => [...rows.values()].filter((r) => r.scope === scope).length
  /** Take slots 1..k of a scope, as if earlier requests had used them. */
  const fill = (scope: string, k: number) => {
    for (let n = 1; n <= k; n++) rows.set(`f-${scope}-${n}`, { scope, n })
  }
  return { rows, count, fill, tools: tools as unknown as ActionTools }
}
