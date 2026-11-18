/**
 * Emails — the application timeline and the sync ledger.
 *
 * Every processed message gets a row, including not-job-related ones, so a
 * re-sync skips anything already in the table (uniqueOn userId +
 * gmailMessageId). Not-job-related rows keep only ids and the label:
 * from/subject/snippet stay empty so unrelated mail is never stored.
 * Read-only for users; only server code writes here.
 */

import type { CollectionSchema, RolePermissions } from 'deepspace/schema'
import { APPLICATION_STATUSES, EMAIL_SOURCES } from './applications-schema'

export const EMAIL_CLASSIFICATIONS = [...APPLICATION_STATUSES, 'not_job_related'] as const

const closed: RolePermissions = { read: false, create: false, update: false, delete: false }
const ownerReadOnly: RolePermissions = { read: 'own', create: false, update: false, delete: false }

export const emailsSchema: CollectionSchema = {
  name: 'emails',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'gmailMessageId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    {
      name: 'source',
      storage: 'text',
      interpretation: { kind: 'select', options: [...EMAIL_SOURCES] },
      required: true,
      immutable: true,
    },
    {
      name: 'classification',
      storage: 'text',
      interpretation: { kind: 'select', options: [...EMAIL_CLASSIFICATIONS] },
      required: true,
    },
    // Empty when not job-related.
    {
      name: 'applicationId',
      storage: 'text',
      interpretation: { kind: 'reference', targetTable: 'applications', displayColumn: 'company' },
    },
    { name: 'receivedAt', storage: 'text', interpretation: { kind: 'datetime' } },
    { name: 'from', storage: 'text', interpretation: 'plain', maxLength: 320 },
    { name: 'subject', storage: 'text', interpretation: 'plain', maxLength: 500 },
    { name: 'snippet', storage: 'text', interpretation: 'plain', maxLength: 1000 },
  ],
  ownerField: 'userId',
  uniqueOn: ['userId', 'gmailMessageId'],
  permissions: {
    '*': closed,
    viewer: closed,
    member: ownerReadOnly,
    admin: ownerReadOnly,
  },
}
