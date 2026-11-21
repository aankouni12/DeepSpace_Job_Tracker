/**
 * App usage — app-wide counters, one row per counter per UTC day: the
 * circuit breakers for owner-billed AI across all accounts.
 *   `assistant-YYYY-MM-DD` → assistantMessages (src/ai/chat-routes.ts)
 *   `sync-YYYY-MM-DD`      → syncs (src/actions/sync.ts)
 *
 * Closed to every role, admin included: written and read only by server code
 * (through the RBAC-off action tools), so no user can see or reset it.
 */

import type { CollectionSchema, RolePermissions } from 'deepspace/schema'

const closed: RolePermissions = { read: false, create: false, update: false, delete: false }

export const appUsageSchema: CollectionSchema = {
  name: 'appUsage',
  columns: [
    { name: 'day', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'assistantMessages', storage: 'number', interpretation: 'plain' },
    { name: 'syncs', storage: 'number', interpretation: 'plain' },
  ],
  permissions: {
    '*': closed,
    viewer: closed,
    member: closed,
    admin: closed,
  },
}
