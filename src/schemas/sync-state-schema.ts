/**
 * Sync state — one row per user (record id = userId), written only by the
 * sync actions. Holds the rate-limit timestamp, so it must not be on `users`:
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
