/**
 * Applications — one row per (user, company, role).
 *
 * Rows are created only by server code (the sync job), so ownership is the
 * explicit `userId` column, not the row creator. `userId` is deliberately NOT
 * `userBound`: with `create: false` for every client role, `userBound` would
 * stamp the writer's id over the intended owner (docs: concepts/permissions).
 * Users may change only `status`, from the board's dropdown.
 */

import type { CollectionSchema, RolePermissions } from 'deepspace/schema'

export const APPLICATION_STATUSES = ['applied', 'interview', 'offer', 'rejected'] as const
export const EMAIL_SOURCES = ['gmail', 'demo'] as const

const closed: RolePermissions = { read: false, create: false, update: false, delete: false }
const ownerOnly: RolePermissions = {
  read: 'own',
  create: false,
  update: 'own',
  delete: false,
  writableFields: ['status'],
}

export const applicationsSchema: CollectionSchema = {
  name: 'applications',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'company', storage: 'text', interpretation: 'plain', required: true, maxLength: 200 },
    { name: 'role', storage: 'text', interpretation: 'plain', required: true, maxLength: 200 },
    // Normalized `company|role`; with userId, the dedupe key for the sync job.
    { name: 'key', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 401 },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: [...APPLICATION_STATUSES] },
      required: true,
    },
    {
      name: 'source',
      storage: 'text',
      interpretation: { kind: 'select', options: [...EMAIL_SOURCES] },
      required: true,
      immutable: true,
    },
    { name: 'lastActivityAt', storage: 'text', interpretation: { kind: 'datetime' } },
  ],
  ownerField: 'userId',
  uniqueOn: ['userId', 'key'],
  permissions: {
    '*': closed,
    viewer: closed,
    member: ownerOnly,
    admin: ownerOnly,
  },
}
