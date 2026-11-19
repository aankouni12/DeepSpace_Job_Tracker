/**
 * Sync state and controls for the board. Every button calls the `sync`
 * server action (src/actions/sync.ts); Connect Gmail is the same call, since a
 * user without Gmail access gets `requiresOAuth` + `authUrl` back (docs:
 * guides/google-oauth, "there is no separate auth-url endpoint").
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui'
import { authedGet, callAction } from '@/lib/utils'

const DAY_MS = 86_400_000

type SyncData = {
  requiresOAuth?: boolean
  authUrl?: string
  applicationsCreated?: number
  applicationsUpdated?: number
  failedBatches?: number
}

export type Source = 'gmail' | 'demo'

export function useSync(syncState?: { lastSyncAt?: string; cursorAt?: string | null }, stateReady = false) {
  const [running, setRunning] = useState<Source | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null)
  const autoTried = useRef(false)

  useEffect(() => {
    authedGet<{ google?: { gmailRead?: boolean } }>('/api/integrations/status').then((s) =>
      setGmailConnected(Boolean(s?.google?.gmailRead)),
    )
  }, [])

  const run = useCallback(async (source: Source, auto = false) => {
    setRunning(source)
    setMessage(null)
    const r = await callAction<SyncData>('sync', { source })
    setRunning(null)
    if (r.success && r.data.requiresOAuth && r.data.authUrl) {
      window.open(r.data.authUrl, '_blank', 'noopener')
      setMessage('Finish connecting Gmail in the new tab, then choose Sync Gmail.')
    } else if (r.success) {
      if (source === 'gmail') setGmailConnected(true)
      const { applicationsCreated = 0, applicationsUpdated = 0, failedBatches = 0 } = r.data
      setMessage(
        failedBatches > 0
          ? `Synced ${applicationsCreated} new and ${applicationsUpdated} updated. Some emails couldn't be sorted and will be retried next sync.`
          : `Synced ${applicationsCreated} new and ${applicationsUpdated} updated.`,
      )
    } else if (r.code === 'rate_limited') {
      const minutes = Math.ceil(Number(r.details?.retryAfterSeconds ?? 600) / 60)
      if (!auto) setMessage(`Synced recently. Try again in ${minutes} min.`)
    } else {
      setMessage(r.error || 'Sync failed. Try again.')
    }
  }, [])

  // Sync on open: once per page load, if Gmail is connected and the last
  // clean Gmail sync is missing or more than a day old.
  useEffect(() => {
    if (autoTried.current || !stateReady || gmailConnected !== true) return
    const cursor = Date.parse(syncState?.cursorAt ?? '')
    if (Number.isFinite(cursor) && Date.now() - cursor < DAY_MS) return
    autoTried.current = true
    void run('gmail', true)
  }, [gmailConnected, stateReady, syncState?.cursorAt, run])

  return { running, message, gmailConnected, run }
}

function lastSynced(iso?: string): string | null {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return null
  const minutes = Math.round((Date.now() - t) / 60_000)
  if (minutes < 1) return 'Last synced just now'
  if (minutes < 60) return `Last synced ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `Last synced ${hours} h ago` : `Last synced ${new Date(t).toLocaleDateString()}`
}

export function SyncControls({
  sync,
  lastSyncAt,
}: {
  sync: ReturnType<typeof useSync>
  lastSyncAt?: string
}) {
  const { running, message, gmailConnected, run } = sync
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => run('demo')}
          disabled={running !== null}
          loading={running === 'demo'}
        >
          Load demo data
        </Button>
        <Button
          size="sm"
          onClick={() => run('gmail')}
          disabled={running !== null}
          loading={running === 'gmail'}
          data-testid="sync-gmail"
        >
          {gmailConnected === false ? 'Connect Gmail' : 'Sync Gmail'}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground" role="status" data-testid="sync-status">
        {running ? 'Syncing. Cards appear as each batch is sorted.' : (message ?? lastSynced(lastSyncAt) ?? '')}
      </p>
    </div>
  )
}
