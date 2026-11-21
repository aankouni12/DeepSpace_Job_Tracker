/**
 * AI Chat Feature — Schema
 *
 * The SDK's pre-built ai-chats / ai-messages schemas, with two changes:
 * - admin gets the member rules (own rows only), matching applications,
 *   emails and syncState; the SDK lets admin read every user's chats.
 * - No client role can update either collection (delete own stays). The SDK
 *   replays stored rows to the model: a stored role "system" message becomes a
 *   system prompt (turnsToCoreMessages), and editing content or
 *   compactedSummary/compactedThroughId would bypass the scope rule and the
 *   size caps. Found by an external security review (2026-11-20).
 *
 * Safe for the chat routes: the SDK's chat-history helpers (getChat,
 * createChat, updateChat, appendMessage, loadMessages, deleteChatCascade) run
 * as the app server-side (`X-App-Action`, RBAC off). Renaming a chat goes
 * through PATCH /api/ai/chats/:id, which accepts only `title`.
 */

import { AI_CHATS_SCHEMA, AI_MESSAGES_SCHEMA, type CollectionSchema, type RolePermissions } from 'deepspace/schema'

const noClientUpdates = (schema: CollectionSchema): CollectionSchema => {
  const member: RolePermissions = { ...schema.permissions.member, update: false }
  return { ...schema, permissions: { ...schema.permissions, member, admin: member } }
}

export const aiChatSchemas: CollectionSchema[] = [
  noClientUpdates(AI_CHATS_SCHEMA),
  noClientUpdates(AI_MESSAGES_SCHEMA),
]
