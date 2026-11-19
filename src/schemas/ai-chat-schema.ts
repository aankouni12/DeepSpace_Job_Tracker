/**
 * AI Chat Feature — Schema
 *
 * The SDK's pre-built ai-chats / ai-messages schemas, with one change: the
 * SDK lets `admin` read every user's chats; here admin gets the member rules
 * (own rows only), matching applications, emails and syncState.
 *
 * Safe for the chat routes: the SDK's chat-history helpers (getChat,
 * createChat, appendMessage, loadMessages, ...) run as the app server-side
 * (`X-App-Action`, RBAC off), so they never relied on admin access.
 */

import { AI_CHATS_SCHEMA, AI_MESSAGES_SCHEMA, type CollectionSchema } from 'deepspace/schema'

const ownOnlyForAdmin = (schema: CollectionSchema): CollectionSchema => ({
  ...schema,
  permissions: { ...schema.permissions, admin: { ...schema.permissions.member } },
})

export const aiChatSchemas: CollectionSchema[] = [
  ownOnlyForAdmin(AI_CHATS_SCHEMA),
  ownOnlyForAdmin(AI_MESSAGES_SCHEMA),
]
