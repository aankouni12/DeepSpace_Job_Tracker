/**
 * Permission checks for applications and emails, run through the SDK's own
 * RBAC functions (the ones RecordRoom enforces with).
 */
import { describe, expect, it } from 'vitest'
import { canCreate, canDelete, canRead, canUpdate, checkFieldPermissions, lintSchemas } from 'deepspace/worker'
import { schemas } from '../schemas'
import { applicationsSchema } from './applications-schema'
import { emailsSchema } from './emails-schema'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const JOB = 'app-owner' // server code writes rows as the app owner

// Created by the sync job (createdBy = JOB), owned by Alice via userId.
const aliceApp = {
  createdBy: JOB,
  data: { userId: ALICE, company: 'Acme', role: 'Engineer', key: 'acme|engineer', status: 'applied', source: 'demo' },
}
const aliceEmail = {
  createdBy: JOB,
  data: { userId: ALICE, gmailMessageId: 'm1', source: 'demo', classification: 'applied' },
}

describe('schema lint', () => {
  it('has no warnings', () => {
    expect(lintSchemas(schemas)).toEqual([])
  })
})

for (const schema of [applicationsSchema, emailsSchema]) {
  const record = schema === applicationsSchema ? aliceApp : aliceEmail

  describe(`${schema.name} permissions`, () => {
    it('owner (by userId, not creator) can read; others cannot', () => {
      for (const role of ['member', 'admin']) {
        expect(canRead(schema, role, record, ALICE)).toBe(true)
        expect(canRead(schema, role, record, BOB)).toBe(false)
      }
    })

    it('signed-out and viewer roles get nothing', () => {
      for (const role of ['*', 'viewer']) {
        expect(canRead(schema, role, record, ALICE)).toBe(false)
        expect(canCreate(schema, role)).toBe(false)
      }
    })

    it('no client role can create or delete', () => {
      for (const role of ['*', 'viewer', 'member', 'admin']) {
        expect(canCreate(schema, role)).toBe(false)
        expect(canDelete(schema, role, record, ALICE)).toBe(false)
      }
    })
  })
}

describe('applications updates', () => {
  it('owner can update; another user cannot', () => {
    expect(canUpdate(applicationsSchema, 'member', aliceApp, ALICE)).toBe(true)
    expect(canUpdate(applicationsSchema, 'member', aliceApp, BOB)).toBe(false)
    expect(canUpdate(applicationsSchema, 'admin', aliceApp, BOB)).toBe(false)
  })

  it('only status is writable', () => {
    expect(checkFieldPermissions(applicationsSchema, 'member', { status: 'interview' }, aliceApp.data)).toBeNull()
    for (const field of ['userId', 'company', 'role', 'key', 'source', 'lastActivityAt']) {
      expect(checkFieldPermissions(applicationsSchema, 'member', { [field]: 'x' }, aliceApp.data)).not.toBeNull()
    }
  })
})

describe('emails updates', () => {
  it('read-only for everyone, including the owner', () => {
    for (const role of ['member', 'admin']) {
      expect(canUpdate(emailsSchema, role, aliceEmail, ALICE)).toBe(false)
    }
  })
})
