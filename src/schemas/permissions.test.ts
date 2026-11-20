/**
 * Permission checks for applications and emails, run through the SDK's own
 * RBAC functions (the ones RecordRoom enforces with).
 */
import { describe, expect, it } from 'vitest'
import type { CollectionSchema } from 'deepspace/schema'
import { canCreate, canDelete, canRead, canUpdate, checkFieldPermissions, lintSchemas } from 'deepspace/worker'
import { schemas } from '../schemas'
import { applicationsSchema } from './applications-schema'
import { emailsSchema } from './emails-schema'
import { syncStateSchema } from './sync-state-schema'

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
const aliceSyncState = {
  createdBy: JOB,
  data: { userId: ALICE, lastSyncAt: '2026-11-18T00:00:00.000Z' },
}

describe('schema lint', () => {
  it('has no warnings', () => {
    expect(lintSchemas(schemas)).toEqual([])
  })
})

const fixtures = new Map<CollectionSchema, { createdBy: string; data: Record<string, unknown> }>([
  [applicationsSchema, aliceApp],
  [emailsSchema, aliceEmail],
  [syncStateSchema, aliceSyncState],
])

for (const [schema, record] of fixtures) {

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

describe('assistant chats and messages', () => {
  // Created server-side by the chat routes as the app, owned by Alice.
  const aliceChat = { createdBy: ALICE, data: { userId: ALICE, title: 'My chat' } }
  const aliceMessage = { createdBy: ALICE, data: { chatId: 'c1', userId: ALICE, role: 'user', content: 'hi' } }

  for (const name of ['ai-chats', 'ai-messages']) {
    const schema = schemas.find((s) => s.name === name)!
    const record = name === 'ai-chats' ? aliceChat : aliceMessage

    it(`${name}: the owner can read; another member or an admin cannot`, () => {
      expect(schema).toBeDefined()
      expect(canRead(schema, 'member', record, ALICE)).toBe(true)
      expect(canRead(schema, 'admin', record, ALICE)).toBe(true)
      expect(canRead(schema, 'member', record, BOB)).toBe(false)
      expect(canRead(schema, 'admin', record, BOB)).toBe(false)
      expect(canRead(schema, 'viewer', record, BOB)).toBe(false)
      expect(canRead(schema, '*', record, BOB)).toBe(false)
    })

    it(`${name}: nobody else can change or delete them, admin included`, () => {
      for (const role of ['member', 'admin']) {
        expect(canUpdate(schema, role, record, BOB)).toBe(false)
        expect(canDelete(schema, role, record, BOB)).toBe(false)
      }
    })
  }
})

describe('appUsage (app-wide assistant counter)', () => {
  const row = { createdBy: JOB, data: { day: '2026-11-19', assistantMessages: 5 } }
  const appUsage = schemas.find((s) => s.name === 'appUsage')!

  it('is closed to every role, admin included: no read, create, update or delete', () => {
    expect(appUsage).toBeDefined()
    for (const role of ['*', 'viewer', 'member', 'admin']) {
      for (const user of [ALICE, JOB]) {
        expect(canRead(appUsage, role, row, user)).toBe(false)
        expect(canUpdate(appUsage, role, row, user)).toBe(false)
        expect(canDelete(appUsage, role, row, user)).toBe(false)
      }
      expect(canCreate(appUsage, role)).toBe(false)
    }
  })
})

describe('syncState updates', () => {
  it('owner cannot reset their own rate limit', () => {
    for (const role of ['member', 'admin']) {
      expect(canUpdate(syncStateSchema, role, aliceSyncState, ALICE)).toBe(false)
    }
  })
})
