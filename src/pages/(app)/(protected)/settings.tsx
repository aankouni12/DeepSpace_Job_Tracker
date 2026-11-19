/**
 * Settings (/settings): account details, sign out, and deleting the user's
 * synced data (the deleteMyData action, scoped to the caller on the server).
 */

import { useState } from 'react'
import { signOut, useUser } from 'deepspace'
import { Button, ConfirmModal } from '@/components/ui'
import { callAction } from '@/lib/utils'

export default function SettingsPage() {
  const { user } = useUser()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const deleteData = async () => {
    setDeleting(true)
    const r = await callAction<{ deleted: { emails: number; applications: number } }>('deleteMyData')
    setDeleting(false)
    setConfirming(false)
    setResult(
      r.success
        ? `Deleted ${r.data.deleted.applications} applications and ${r.data.deleted.emails} emails.`
        : r.error,
    )
  }

  return (
    // No background on page wrappers — pages render into whatever the app's
    // (app)/_layout provides, so they stay transparent and inherit it.
    <div className="min-h-full text-foreground">
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-20">
        <h1 className="mb-6 text-4xl font-semibold tracking-tight">Settings</h1>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">Your account</h2>

          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Name</dt>
              <dd className="text-foreground">{user?.name ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="text-foreground">{user?.email ?? '—'}</dd>
            </div>
          </dl>

          <Button variant="secondary" className="mt-6" onClick={() => signOut()}>
            Sign out
          </Button>
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-2 text-lg font-semibold">Synced data</h2>
          <p className="text-sm text-muted-foreground">
            Delete the applications and emails applytrack has saved for you, including demo data.
            Your next Gmail sync starts from the last 60 days again.
          </p>
          <Button variant="destructive" className="mt-4" onClick={() => setConfirming(true)}>
            Delete my synced data
          </Button>
          {result && (
            <p className="mt-3 text-sm" role="status" data-testid="delete-result">
              {result}
            </p>
          )}
        </section>
      </div>

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={deleteData}
        loading={deleting}
        title="Delete your synced data?"
        description="This removes every application and email applytrack has saved for you. It can't be undone."
        confirmText="Delete my synced data"
      />
    </div>
  )
}
