/**
 * One application on the board: company, role, latest activity, email count,
 * a status picker (the only field users may write), and the email timeline
 * for spot-checking how it was classified.
 */

import { useState } from 'react'
import { Modal } from '@/components/ui'

export const STATUSES = [
  { id: 'applied', label: 'Applied' },
  { id: 'interview', label: 'Interview' },
  { id: 'offer', label: 'Offer' },
  { id: 'rejected', label: 'Rejected' },
] as const

export type Status = (typeof STATUSES)[number]['id']

export const statusInk = (s: string) => `var(--status-${s})`

export interface Application {
  company: string
  role: string
  status: Status
  lastActivityAt?: string
}

export interface EmailRow {
  applicationId?: string
  classification: string
  receivedAt?: string
  from?: string
  subject?: string
  snippet?: string
}

const day = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''

const labelOf = (id: string) => STATUSES.find((s) => s.id === id)?.label ?? 'Not job-related'

export function ApplicationCard({
  app,
  emails,
  canEdit,
  onStatusChange,
}: {
  app: Application
  emails: EmailRow[]
  canEdit: boolean
  onStatusChange: (status: Status) => void
}) {
  const [open, setOpen] = useState(false)
  const count = emails.length

  return (
    <article
      data-testid="application-card"
      className="rounded-md border border-l-4 border-border bg-card p-3"
      style={{ borderLeftColor: statusInk(app.status) }}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="block font-semibold leading-snug">{app.company}</span>
        <span className="block text-sm text-muted-foreground">{app.role}</span>
        <span className="mt-2 block text-xs tabular-nums text-muted-foreground">
          {count} {count === 1 ? 'email' : 'emails'}, latest {day(app.lastActivityAt)}
        </span>
      </button>

      <label className="mt-3 block text-xs text-muted-foreground">
        <span className="sr-only">Status for {app.company}</span>
        <select
          value={app.status}
          disabled={!canEdit}
          onChange={(e) => onStatusChange(e.target.value as Status)}
          className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground disabled:opacity-50"
        >
          {STATUSES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <Modal open={open} onClose={() => setOpen(false)} size="lg">
        <Modal.Header>
          <Modal.Title>
            {app.company}, {app.role}
          </Modal.Title>
          <Modal.Description>How each email about this application was sorted.</Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <ol className="space-y-4" data-testid="timeline">
            {[...emails]
              .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))
              .map((e, i) => (
                <li key={i} className="border-l-2 pl-3" style={{ borderColor: statusInk(e.classification) }}>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {day(e.receivedAt)}, sorted as {labelOf(e.classification)}
                  </p>
                  <p className="font-medium">{e.subject}</p>
                  <p className="text-sm text-muted-foreground">{e.from}</p>
                  <p className="mt-1 text-sm">{e.snippet}</p>
                </li>
              ))}
          </ol>
        </Modal.Body>
      </Modal>
    </article>
  )
}
