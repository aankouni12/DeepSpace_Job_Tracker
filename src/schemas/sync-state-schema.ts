/**
 * Sync state — one row per user (record id = userId), written only by the
 * sync actions and the assistant route. Holds the rate limits, so it must not be on `users`:
 * members can update their own users row and would reset their own limit.
 * Users may read their own row (for "last synced"); nobody can write it.
 */

import type { CollectionSchema, RolePermissions } from 'deepspace/schema'

const closed: RolePermissions = { read: false, create: false, update: false, delete: false }
const ownerReadOnly: RolePermissions = { read: 'own', create: false, update: false, delete: false }

export const syncStateSchema: CollectionSchema = {
  name: 'syncState',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'lastSyncAt', storage: 'text', interpretation: { kind: 'datetime' } },
    // Gmail cursor: advanced only after a sync with no failed batches.
    { name: 'cursorAt', storage: 'text', interpretation: { kind: 'datetime' } },
    // No longer written (2026-11-21): the assistant and demo limits moved to
    // atomic tickets (src/server/usage-tickets.ts). Kept so rows already
    // stored in production still match the table.
    { name: 'chatWindowStart', storage: 'text', interpretation: { kind: 'datetime' } },
    { name: 'chatCount', storage: 'number', interpretation: 'plain' },
    { name: 'demoWindowStart', storage: 'text', interpretation: { kind: 'datetime' } },
    { name: 'demoCount', storage: 'number', interpretation: 'plain' },
  ],
  ownerField: 'userId',
  uniqueOn: ['userId'],
  permissions: {
    '*': closed,
    viewer: closed,
    member: ownerReadOnly,
    admin: ownerReadOnly,
  },
}
