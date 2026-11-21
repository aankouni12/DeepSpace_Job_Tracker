/**
 * AI chat routes — multi-turn tool-use via Vercel AI SDK + DeepSpace proxy.
 *
 * Registers four endpoints on the passed-in Hono app:
 *   POST   /api/ai/chats       — create a chat owned by the caller
 *   PATCH  /api/ai/chats/:id   — rename / patch a chat
 *   DELETE /api/ai/chats/:id   — delete chat + cascade messages
 *   POST   /api/ai/chat        — streamed assistant turn (the big one)
 *
 * Lives in its own file so worker.ts can stay small and the streaming
 * handler's full context (compaction, tools, persistence, abort handling)
 * is co-located rather than scattered through the entry file.
 */

import type { Context, Hono } from 'hono'
import { createUIMessageStreamResponse, toUIMessageStream, type ModelMessage } from 'ai'
import {
  deepSpaceAgentErrorSummary,
  prepareMessagesWithCompaction,
  resolveDeepSpaceAgentModel,
  streamDeepSpaceAgent,
  turnsToCoreMessages,
  buildUiParts,
  makeDefaultSummarizer,
  createUserToolExecutor,
  DEFAULT_CONTEXT_CONFIG,
  getChat,
  createChat,
  updateChat,
  deleteChatCascade,
  loadMessages,
  appendMessage,
  loggableError,
} from 'deepspace/worker'
import type { ActionTools, AgentToolAccessResult, AgentToolRouteOptions, ChatTurn } from 'deepspace/worker'
import { buildSystemPrompt } from './tools.js'
import { createActionTools } from '../server/action-routes.js'
import { claimTicket, releaseTicket, secondsToNextUtcDay, utcDay } from '../server/usage-tickets.js'
// Type-only — TypeScript strips these at runtime, so no circular import
// with worker.ts (which imports `registerAiChatRoutes` from this file).
import type { Env, AppContext } from '../../worker.js'

type ResolveAccess = (req: Request, env: Env) => Promise<AgentToolAccessResult>
type AccessGrant = Extract<AgentToolAccessResult, { ok: true }>
/** `buildTools` from src/ai/tools.ts; it may ignore the context argument. */
type ToolFactory = AgentToolRouteOptions<Env>['buildTools']

function recordRoomStub(env: Env): DurableObjectStub {
  // Rooms are keyed by the immutable app id — the same `app:${DEEPSPACE_APP_ID}`
  // the client's RecordScope (SCOPE_ID) and worker.ts's own stubs use. Keying
  // by APP_NAME would read/write a room the browser never subscribes to.
  return env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
}

// The assistant is owner-billed, so the server picks the model (the client's
// modelId is ignored) and bounds every cost driver of a message.
const ASSISTANT_MODEL = 'claude-haiku-5-5'
const MAX_USER_CONTENT_LENGTH = 2_000
/** Chat titles from the client (create/rename) are clipped to this; never sent to the model. */
export const MAX_TITLE_LENGTH = 100
export const clipTitle = (title: string) => title.slice(0, MAX_TITLE_LENGTH)
/**
 * Per model call (the SDK default is 64,000). A message makes at most
 * MAX_TOOL_CALLS + 1 calls. Haiku 5.5's hidden thinking counts against this
 * too, and the DeepSpace agent stream doesn't let callers turn thinking off
 * (no providerOptions/reasoning) or budget it separately, so this leaves room
 * for thinking plus a full answer. 500 cut replies off (2026-11-19); the
 * heaviest question tested used 1,368, so 2,000 leaves real headroom.
 */
export const ASSISTANT_MAX_OUTPUT_TOKENS = 2000
/** Appended when a reply still hits the cap, instead of a sentence that just stops. */
export const SHORTENED_NOTE = '(reply shortened)'

type StreamPart = { type: string; finishReason?: string }

/** Adds SHORTENED_NOTE as text before the finish-step of a step cut off by the token cap. */
export function markShortened<T extends StreamPart>(stream: ReadableStream<T>): ReadableStream<T> {
  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(part, controller) {
        if (part.type === 'finish-step' && part.finishReason === 'length') {
          const id = 'reply-shortened'
          for (const extra of [
            { type: 'text-start', id },
            { type: 'text-delta', id, text: `\n\n${SHORTENED_NOTE}` },
            { type: 'text-end', id },
          ]) {
            controller.enqueue(extra as unknown as T)
          }
        }
        controller.enqueue(part)
      },
    }),
  )
}
export const ASSISTANT_MAX_TOOL_CALLS = 4
/** History over 30,000 characters is summarized (SDK default 240,000). */
export const ASSISTANT_CONTEXT_CONFIG = { ...DEFAULT_CONTEXT_CONFIG, contextBudget: 30_000 }

/** The model settings every assistant turn uses (exported so tests check the real wiring). */
export function assistantStreamSettings(now: Date) {
  return {
    profile: 'application' as const,
    modelId: ASSISTANT_MODEL,
    // No authToken: bills the app owner (APP_OWNER_JWT), so reviewers with
    // zero credits can chat. Bounded by the limits below.
    effort: 'low' as const,
    maxToolCalls: ASSISTANT_MAX_TOOL_CALLS,
    maxOutputTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
    instructions: buildSystemPrompt(now),
  }
}

// Per-user message limit, per UTC day, and the app-wide circuit breaker across
// all accounts. Both are atomic ticket scopes (src/server/usage-tickets.ts):
// parallel requests can't all pass. Change either number here.
export const CHAT_DAILY_LIMIT = 30
export const APP_DAILY_LIMIT = 200

export type ChatClaim =
  | { ok: true }
  | { ok: false; scope: 'user' | 'app'; retryAfterSeconds: number }

/**
 * Take one message from the caller's daily limit and the app-wide one, or
 * refuse without using either (a user slot taken before an app-wide refusal
 * is given back). `tools` must be the server's RBAC-off action tools;
 * `userId` is the verified caller only.
 */
export async function claimChatMessage(tools: ActionTools, userId: string, now: number): Promise<ChatClaim> {
  const day = utcDay(now)
  const retryAfterSeconds = secondsToNextUtcDay(now)
  const user = await claimTicket(tools, `assistant-user-${userId}-${day}`, CHAT_DAILY_LIMIT)
  if (!user) return { ok: false, scope: 'user', retryAfterSeconds }
  const app = await claimTicket(tools, `assistant-app-${day}`, APP_DAILY_LIMIT)
  if (!app) {
    await releaseTicket(tools, user)
    return { ok: false, scope: 'app', retryAfterSeconds }
  }
  return { ok: true }
}

export function limitMessage(claim: Extract<ChatClaim, { ok: false }>): string {
  const hours = Math.max(1, Math.ceil(claim.retryAfterSeconds / 3600))
  const when = `Try again in about ${hours} hour${hours === 1 ? '' : 's'}.`
  return claim.scope === 'app'
    ? `The assistant has reached today's limit for everyone. ${when}`
    : `You've used all ${CHAT_DAILY_LIMIT} assistant messages for today. ${when}`
}

// Derive a chat title from the first user message — first non-empty line,
// trimmed to ~50 chars with an ellipsis.
function deriveTitle(content: string): string {
  const first =
    content
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? 'Untitled'
  return first.length <= 50 ? first : first.slice(0, 47).trimEnd() + '…'
}

export function registerAiChatRoutes(
  app: Hono<AppContext>,
  resolveAccess: ResolveAccess,
  buildTools: ToolFactory,
): void {
  // One chokepoint for the access-decision → HTTP mapping on every chat route.
  const requireAccess = async (c: Context<AppContext>): Promise<AccessGrant | Response> => {
    const access = await resolveAccess(c.req.raw, c.env)
    if (access.ok) return access
    const error =
      access.status === 401
        ? 'Unauthorized'
        : access.status === 403
          ? 'Forbidden'
          : 'Temporarily unavailable'
    return c.json({ error }, access.status)
  }

  // Create a new chat row owned by the caller.
  app.post('/api/ai/chats', async (c) => {
    const access = await requireAccess(c)
    if (access instanceof Response) return access
    const { auth } = access

    const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string })
    const stub = recordRoomStub(c.env)
    const chat = await createChat(stub, auth.userId, {
      title: typeof body.title === 'string' ? clipTitle(body.title) : 'New chat',
    })
    return c.json({ chat })
  })

  // Rename / patch a chat. Ownership enforced via getChat.
  app.patch('/api/ai/chats/:id', async (c) => {
    const access = await requireAccess(c)
    if (access instanceof Response) return access
    const { auth } = access

    const id = c.req.param('id')
    const stub = recordRoomStub(c.env)
    const chat = await getChat(stub, id, auth.userId)
    if (!chat) return c.json({ error: 'Not found' }, 404)

    const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string })
    const patch: { title?: string } = {}
    if (typeof body.title === 'string') patch.title = clipTitle(body.title)
    // `updateChat` re-checks the chat; a delete racing this PATCH answers 404
    // instead of `ok: true` for a write that never landed.
    if (!(await updateChat(stub, id, auth.userId, patch)))
      return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true })
  })

  // Delete chat + cascade messages.
  app.delete('/api/ai/chats/:id', async (c) => {
    const access = await requireAccess(c)
    if (access instanceof Response) return access
    const { auth } = access

    const id = c.req.param('id')
    const stub = recordRoomStub(c.env)
    const chat = await getChat(stub, id, auth.userId)
    if (!chat) return c.json({ error: 'Not found' }, 404)

    await deleteChatCascade(stub, id, auth.userId)
    return c.json({ ok: true })
  })

  // Known limitation: two tabs sending to the same chatId concurrently can
  // interleave row writes (DO serializes individual writes but not the
  // per-request 3-write group). The next turn's history then mis-pairs
  // user/assistant rows. Closing this requires per-chatId locking in the DO;
  // out of scope for this PR. Realistic impact: rare (multi-tab same-chat
  // usage); recoverable by user (one tab works correctly going forward).
  app.post('/api/ai/chat', async (c) => {
    const access = await requireAccess(c)
    if (access instanceof Response) return access
    const { auth } = access

    const authHeader = c.req.header('Authorization') ?? ''
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!jwt) return c.json({ error: 'Unauthorized' }, 401)

    const { chatId, userMessageId, content } = await c.req.json<{
      chatId?: string
      userMessageId?: string
      content?: string
    }>()
    if (typeof chatId !== 'string' || !chatId) return c.json({ error: 'chatId is required' }, 400)
    if (typeof userMessageId !== 'string' || !userMessageId)
      return c.json({ error: 'userMessageId is required' }, 400)
    if (typeof content !== 'string' || content.trim() === '')
      return c.json({ error: 'content is required' }, 400)
    if (content.length > MAX_USER_CONTENT_LENGTH) {
      return c.json({ error: `content exceeds ${MAX_USER_CONTENT_LENGTH} chars` }, 413)
    }
    const selectedModel = resolveDeepSpaceAgentModel(ASSISTANT_MODEL, 'application')
    if (!selectedModel) throw new Error(`${ASSISTANT_MODEL} is not an application agent model`)

    const stub = recordRoomStub(c.env)
    const chat = await getChat(stub, chatId, auth.userId)
    if (!chat) {
      console.warn('[ai-chat] REQUEST chat-not-found', { userId: auth.userId, chatId })
      return c.json({ error: 'Chat not found' }, 404)
    }

    // Before any model call (compaction included). Plain text: the panel
    // shows the response body as the error message.
    const quota = await claimChatMessage(createActionTools(c.env, auth.userId, jwt), auth.userId, Date.now())
    if (!quota.ok) return c.text(limitMessage(quota), 429)

    // Load history before writing this turn. `persistTurn` later writes user then
    // assistant as separate DO operations; the ordering is intentional, but
    // it is not atomic.
    const history = await loadMessages(stub, chatId, auth.userId)
    // Carry `parts` through so compaction can truncate stale tool results AND
    // turnsToCoreMessages can rebuild assistant tool-call/tool-result pairs.
    const rawTurns: ChatTurn[] = history.map((m) => ({
      id: m.recordId,
      role: m.role,
      content: m.content,
      parts: m.parts,
    }))

    // Append the in-flight user message in memory so the LLM sees it; its DO
    // write is the first persistence operation in `persistTurn`.
    // Then dedup consecutive user messages — defense-in-depth for legacy
    // chats with orphan user rows AND for the rare case where a prior turn's
    // user-write succeeded but the assistant-write failed both retries.
    // Crucial: dedup runs AFTER appending the in-flight; otherwise a trailing
    // orphan user from history would survive the loop (no following user in
    // raw history) and then sit next to the in-flight user, sending two
    // consecutive user messages to the LLM.
    const allTurns: ChatTurn[] = [...rawTurns, { id: userMessageId, role: 'user', content }]
    const turns: ChatTurn[] = []
    for (let i = 0; i < allTurns.length; i++) {
      if (allTurns[i].role === 'user' && allTurns[i + 1]?.role === 'user') continue
      turns.push(allTurns[i])
    }

    const cachedSummary =
      chat.compactedSummary && chat.compactedThroughId
        ? { text: chat.compactedSummary, throughId: chat.compactedThroughId }
        : undefined

    // Owner-billed (no authToken), like the chat itself; covered by the limit above.
    const summarizer = makeDefaultSummarizer(c.env)
    const { messages: prepared, newSummary } = await prepareMessagesWithCompaction(
      turns,
      ASSISTANT_CONTEXT_CONFIG,
      { summarizer, cachedSummary },
    )
    if (newSummary) {
      await updateChat(stub, chatId, auth.userId, {
        compactedSummary: newSummary.text,
        compactedThroughId: newSummary.throughId,
      })
    }

    const usedModelId = selectedModel.modelId
    const diagnosticContext = {
      profile: 'application' as const,
      provider: selectedModel.provider,
      modelId: usedModelId,
    }
    const settings = assistantStreamSettings(new Date())
    const baseSystem = settings.instructions

    // Compaction inserts at most one summary system message at index 0; fold
    // it into the top-level `system` so we don't pass two system roles. Then
    // convert the remaining ChatTurns into AI SDK ModelMessages — splitting
    // assistant rows into the assistant + paired tool messages the SDK expects.
    const [first, ...rest] = prepared
    const summary = first?.role === 'system' ? first : null
    const systemText = summary ? `${baseSystem}\n\n${summary.content}` : baseSystem
    const messages = turnsToCoreMessages(summary ? rest : prepared)

    // The SDK executor runs each tool as the verified user, in the room the
    // access grant admitted them to, and forwards the route's abort signal, so
    // a tool fetch in flight is cancelled if the client navigates away
    // mid-stream. The local assistant routes use the same executor and
    // context, and streamDeepSpaceAgent caps each tool result for the model,
    // keeping both surfaces' tool behavior identical.
    const tools = buildTools(
      createUserToolExecutor(c.env, auth.userId, c.req.raw.signal, { room: access.room }),
      { env: c.env, userId: auth.userId, request: c.req.raw },
    )

    // Allocate the assistant row id BEFORE streaming starts so we can echo it
    // back via a response header. The client tags its in-flight overlay with
    // this id and dedups against the WebSocket-broadcast persisted row by id —
    // not by comparing `spawnTime` (client clock) to `createdAt` (server clock),
    // which broke for users whose clock was ahead of the server.
    const asstId = `asst-${Date.now()}-${crypto.randomUUID()}`

    // Save the finished turn: every step's messages (tool calls included), not
    // just the final step's. Called on normal completion and when the request
    // is aborted after at least one step completed.
    const persistTurn = async (
      rawText: string,
      responseMessages: ModelMessage[],
      shortened = false,
    ): Promise<void> => {
      const parts = buildUiParts(responseMessages)
      // Keep the "(reply shortened)" note after a reload, as the stream showed it.
      if (shortened) parts.push({ type: 'text', text: SHORTENED_NOTE } as (typeof parts)[number])
      const text = shortened ? `${rawText}\n\n${SHORTENED_NOTE}` : rawText
      if (text.trim() === '' && parts.length === 0) {
        console.warn('[ai-chat] FINISH empty turn, skipping persist')
        return
      }

      // Persist user → assistant → metadata as independent writes, not a
      // transaction. Order matters: user FIRST so chronological reads are
      // correct, then assistant. If user-write
      // exhausts retries we ABORT the assistant write — otherwise we'd persist
      // an assistant row with no preceding user row, breaking the invariant
      // relied on by the dedup + turnsToCoreMessages loop on the next turn.
      //
      // The helpers return `false` (no throw) when the chat no longer exists
      // — deleted mid-stream — and nothing was written; that is not retried,
      // and it stops the sequence the same way an exhausted retry does.
      const writeWithRetry = async (
        label: string,
        fn: () => Promise<boolean | void>,
      ): Promise<boolean> => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            if ((await fn()) === false) {
              console.warn(`[ai-chat] ${label} skipped — chat ${chatId} no longer exists`)
              return false
            }
            return true
          } catch (err) {
            console.error(`[ai-chat] ${label} ${attempt === 1 ? 'failed, retrying once' : 'retry failed'}: ${loggableError(err)}`)
          }
        }
        return false
      }

      const userOk = await writeWithRetry('user message', () =>
        appendMessage(stub, {
          id: userMessageId,
          chatId,
          userId: auth.userId,
          role: 'user',
          content,
        }),
      )
      if (!userOk) {
        console.error(
          '[ai-chat] FINISH aborting — user write did not land; skipping assistant + metadata to avoid orphan rows',
        )
        return
      }
      const assistantOk = await writeWithRetry('assistant message', () =>
        appendMessage(stub, {
          id: asstId,
          chatId,
          userId: auth.userId,
          role: 'assistant',
          content: text,
          ...(parts.length > 0 ? { parts } : {}),
        }),
      )
      if (!assistantOk) return
      await writeWithRetry('chat metadata', async () => {
        // Re-fetch so a mid-stream rename by the user isn't clobbered by a
        // stale "auto-title" derived from the captured `chat` snapshot. A
        // chat deleted mid-stream reads back as null; `updateChat` refuses
        // that case on its own (an unguarded `records.update` would upsert
        // the row back into existence), so this only decides the title.
        const fresh = await getChat(stub, chatId, auth.userId)
        const patch: { title?: string; model?: string } = { model: usedModelId }
        if (fresh && (!fresh.title || fresh.title === 'New chat')) {
          patch.title = deriveTitle(content)
        }
        return updateChat(stub, chatId, auth.userId, patch)
      })
    }

    const { result } = streamDeepSpaceAgent(c.env, {
      ...settings,
      instructions: systemText,
      messages,
      tools,
      // Cancel provider and tool work with the request. `onAbort` then saves
      // any completed steps; a zero-step abort saves nothing.
      abortSignal: c.req.raw.signal,
      onError: ({ error }) => {
        console.error(
          `[ai-chat] stream error: ${deepSpaceAgentErrorSummary(error, diagnosticContext)}`,
        )
      },
      onEnd: ({ text, responseMessages, finishReason }) =>
        persistTurn(text, responseMessages as ModelMessage[], finishReason === 'length'),
      // AI SDK skips `onEnd` on abort; keep the steps that did complete.
      onAbort: ({ steps }) => {
        const last = steps.at(-1)
        if (!last) return
        return persistTurn(last.text, steps.flatMap((step) => step.response.messages) as ModelMessage[])
      },
    })

    return createUIMessageStreamResponse({
      headers: {
        // Lets the client tag its in-flight assistant overlay with the same id
        // the worker will use in `persistTurn`, so dedup against
        // the WebSocket-broadcast row is by id (clock-skew-proof).
        'X-Asst-Id': asstId,
      },
      stream: toUIMessageStream({
        stream: markShortened(result.stream),
        // Reasoning models (o-series, Claude with extended thinking) emit
        // `reasoning-start`/`reasoning-delta`/`reasoning-end` chunks. We
        // don't render them today — pass them through and the user sees a
        // stuck spinner during long thinks. Opt out at the boundary until
        // the UI gains a "thinking" disclosure block.
        sendReasoning: false,
        onError: (error: unknown): string => {
          // The return value becomes the user-visible `errorText` for every
          // `tool-input-error` / `tool-output-error` chunk and stream-level
          // error. Surface the real message so RBAC denials and validation
          // failures are debuggable; log full detail server-side.
          console.error(`[ai-chat] response error: ${loggableError(error)}`)
          return error instanceof Error ? error.message : String(error)
        },
      }),
    })
  })
}
