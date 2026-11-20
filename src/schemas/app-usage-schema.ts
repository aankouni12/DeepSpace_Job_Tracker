/**
 * App usage — app-wide counters, one row per UTC day (record id
 * `assistant-YYYY-MM-DD`). The circuit breaker for owner-billed assistant
 * messages across all accounts.
 *
 * Closed to every role, admin included: written and read only by server code
 * (src/ai/chat-routes.ts, through the RBAC-off action tools), so no user can
 * see or reset it.
 */

import type { CollectionSchema, RolePermissions } from 'deepspace/schema'

const closed: RolePermissions = { read: false, create: false, update: false, delete: false }

export const appUsageSchema: CollectionSchema = {
  name: 'appUsage',
  columns: [
    { name: 'day', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'assistantMessages', storage: 'number', interpretation: 'plain' },
  ],
  permissions: {
    '*': closed,
    viewer: closed,
    member: closed,
    admin: closed,
  },
}
