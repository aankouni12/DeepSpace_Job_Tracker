/**
 * The pipeline board (/board). Applications, emails and sync state are each
 * one live useQuery; the collections' `read: 'own'` rules mean each user only
 * ever receives their own rows, so the board updates as sync writes batches.
 */

import { useMemo, useState } from 'react'
import { useMutations, useQuery, useUser } from 'deepspace'
import { ChatPanel } from '@/components/ChatPanel'
import { Button, useToast } from '@/components/ui'
import {
  ApplicationCard,
  STATUSES,
  statusInk,
  type Application,
  type EmailRow,
  type Status,
} from '@/components/ApplicationCard'
import { SyncControls, useSync } from '@/components/SyncControls'

type SyncStateRow = { lastSyncAt?: string; cursorAt?: string | null }

export default function BoardPage() {
  const apps = useQuery<Application>('applications')
  const emails = useQuery<EmailRow>('emails')
  const syncState = useQuery<SyncStateRow>('syncState')
  const { put, ready } = useMutations<Application>('applications')
  const { error } = useToast()
  const { user } = useUser()
  const [assistantOpen, setAssistantOpen] = useState(false)

  const state = syncState.records[0]?.data
  const sync = useSync(state, syncState.status === 'ready')

  const emailsByApp = useMemo(() => {
    const m = new Map<string, EmailRow[]>()
    for (const r of emails.records) {
      const id = r.data.applicationId
      if (id) m.set(id, [...(m.get(id) ?? []), r.data])
    }
    return m
  }, [emails.records])

  const lanes = useMemo(
    () =>
      STATUSES.map((s) => ({
        ...s,
        cards: apps.records
          .filter((r) => r.data.status === s.id)
          .sort((a, b) => (b.data.lastActivityAt ?? '').localeCompare(a.data.lastActivityAt ?? '')),
      })),
    [apps.records],
  )

  if (apps.status === 'loading') return <div aria-busy="true" className="min-h-full" />

  const hasGmailData =
    apps.records.some((r) => r.data.source === 'gmail') || emails.records.some((r) => r.data.source === 'gmail')

  if (apps.records.length === 0 && !sync.running) {
    return <FirstRun sync={sync} hasGmailData={hasGmailData} />
  }

  const changeStatus = (recordId: string, status: Status) =>
    put(recordId, { status }).catch(() => error('Could not change status', 'Try again.'))

  return (
    <div className="mx-auto flex min-h-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Applications</h1>
          <p className="text-sm text-muted-foreground">
            Sorted from your email replies. Change a status if it&apos;s wrong.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <SyncControls
            sync={sync}
            lastSyncAt={state?.lastSyncAt}
            hasGmailData={hasGmailData}
            hasDemoData={apps.records.some((r) => r.data.source === 'demo')}
          />
          <Button variant="outline" onClick={() => setAssistantOpen((o) => !o)} aria-expanded={assistantOpen}>
            {assistantOpen ? 'Close assistant' : 'Ask the assistant'}
          </Button>
        </div>
      </header>

      {assistantOpen && user && (
        <aside
          aria-label="Assistant"
          data-testid="assistant-panel"
          className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-background shadow-xl sm:w-[26rem]"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="font-medium">Assistant</h2>
            <Button variant="ghost" size="sm" onClick={() => setAssistantOpen(false)}>
              Close
            </Button>
          </div>
          <ChatPanel
            chatId={null}
            userId={user.id}
            models={[]}
            compact
            className="min-h-0 flex-1"
            emptyStatePrompts={[
              "Which companies haven't replied in 2 weeks?",
              'How many rejections this month?',
              'What should I follow up on?',
            ]}
          />
        </aside>
      )}

      <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-4">
        {lanes.map((lane) => (
          <section
            key={lane.id}
            aria-labelledby={`lane-${lane.id}`}
            data-testid={`lane-${lane.id}`}
            className="w-[78vw] shrink-0 snap-start sm:w-auto"
          >
            <h2 id={`lane-${lane.id}`} className="mb-3 flex items-baseline gap-3 border-b border-border pb-2">
              <span className="text-4xl font-semibold tabular-nums" style={{ color: statusInk(lane.id) }}>
                {lane.cards.length}
              </span>
              <span className="text-base font-medium">{lane.label}</span>
            </h2>
            <div className={lane.id === 'rejected' ? 'space-y-3 opacity-75' : 'space-y-3'}>
              {lane.cards.map((r) => (
                <ApplicationCard
                  key={r.recordId}
                  app={r.data}
                  emails={emailsByApp.get(r.recordId) ?? []}
                  canEdit={ready}
                  onStatusChange={(s) => changeStatus(r.recordId, s)}
                />
              ))}
              {lane.cards.length === 0 && (
                <p className="text-sm text-muted-foreground">Nothing here yet.</p>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function FirstRun({ sync, hasGmailData }: { sync: ReturnType<typeof useSync>; hasGmailData: boolean }) {
  return (
    <div className="mx-auto grid min-h-full max-w-5xl items-center gap-12 px-6 py-16 md:grid-cols-[1.1fr_1fr]">
      <div data-testid="first-run">
        <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Your job applications, sorted from your inbox.
        </h1>
        <p className="mt-4 max-w-prose text-lg text-muted-foreground">
          applytrack reads the replies to your job applications in Gmail and sorts each one into
          Applied, Interview, Offer or Rejected, so you can see where everything stands.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          {!hasGmailData && (
            <Button size="lg" onClick={() => sync.run('demo')} disabled={sync.running !== null}>
              Try with demo data
            </Button>
          )}
          <Button size="lg" variant="outline" onClick={() => sync.run('gmail')} disabled={sync.running !== null}>
            Connect Gmail
          </Button>
        </div>
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          {sync.message ?? 'Demo data is fictional. You can delete it any time in Settings.'}
        </p>
      </div>

      {/* The shape of the board to come: four lanes in their status inks. */}
      <div aria-hidden="true" className="hidden grid-cols-4 gap-3 md:grid">
        {STATUSES.map((s, i) => (
          <div key={s.id} className="space-y-2">
            <div className="h-1.5 rounded-full" style={{ background: statusInk(s.id) }} />
            {Array.from({ length: 3 - (i % 3) }, (_, j) => (
              <div
                key={j}
                className="h-14 rounded-md border border-l-4 border-border bg-card"
                style={{ borderLeftColor: statusInk(s.id), opacity: 0.5 }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
