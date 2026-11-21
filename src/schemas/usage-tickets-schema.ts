/**
 * Usage tickets — one row per use of a limited, owner-billed resource (a demo
 * sync, a Gmail sync, an assistant message). Each limit is a `scope` with slots
 * 1..limit; claiming a use creates the row `{ scope, n }`.
 *
 * Why tickets and not a counter: a counter is read-check-write across separate
 * tool calls, so parallel requests all read the same count and every one
 * passes (found in the user's review, 2026-11-21). `uniqueOn: ['scope', 'n']`
 * makes RecordRoom refuse a second create of the same slot with "Duplicate",
 * and its duplicate check and INSERT run in one synchronous stretch inside the
 * Durable Object (deepspace 0.44.x putRecord), so two requests can never both
 * get slot n. Record ids are left to the SDK: records.create with an existing
 * recordId UPDATES that row instead of failing, so ids can't be the lock.
 *
 * Closed to every role, admin included: written and read only by server code
 * (src/server/usage-tickets.ts, through the RBAC-off action tools).
 */

import type { CollectionSchema, RolePermissions } from 'deepspace/schema'

const closed: RolePermissions = { read: false, create: false, update: false, delete: false }

export const usageTicketsSchema: CollectionSchema = {
  name: 'usageTickets',
  columns: [
    { name: 'scope', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 200 },
    { name: 'n', storage: 'number', interpretation: 'plain', required: true, immutable: true },
  ],
  uniqueOn: ['scope', 'n'],
  permissions: {
    '*': closed,
    viewer: closed,
    member: closed,
    admin: closed,
  },
}
