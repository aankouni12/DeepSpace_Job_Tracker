/**
 * Landing page — a STATIC page.
 *
 * It lives at the top level of src/pages/ (not under (app)/), so it renders
 * with no DeepSpace providers: no auth session fetch, no records WebSocket.
 * "Get started" is a plain link to /board; the protected layout there handles
 * sign-in. Prerendered to static HTML at build (prerender.ts), so keep it
 * renderable without a browser. `<Seo>` comes first and reads src/seo.ts.
 */

import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { APP_NAME } from '../constants'
import { seo } from '../seo'

const PRIVACY = [
  {
    title: 'Read-only Gmail',
    body: 'applytrack can read your inbox but never send, delete, or change anything in it.',
  },
  {
    title: 'Email text is used only to sort',
    body: "Email text is sent to the AI model to classify, then discarded. For job emails, applytrack keeps the sender, subject, date, and Gmail's short preview; for other mail, nothing but an id.",
  },
  {
    title: 'Your data is only yours',
    body: 'Only you can see your applications, admins included. Delete all of it from Settings at any time.',
  },
]

export default function Landing() {
  return (
    <>
      <Seo {...seo} path="/" />
      <main
        data-testid="static-landing"
        className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16"
      >
        <p className="mb-3 text-sm font-medium uppercase tracking-widest text-muted-foreground">{APP_NAME}</p>
        <h1 className="mb-4 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Your job search, sorted from your inbox
        </h1>
        <p className="mb-8 max-w-xl text-lg text-muted-foreground">
          applytrack reads your job application emails and sorts them into a live board: Applied,
          Interview, Offer, Rejected. An assistant answers questions about your search, but it can't
          change anything without your click.
        </p>
        <div className="mb-12">
          <Link
            to="/board"
            className="inline-flex items-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
        </div>
        <ul className="grid gap-3 sm:grid-cols-3">
          {PRIVACY.map((p) => (
            <li key={p.title} className="rounded-md border border-border bg-card p-4">
              <h2 className="mb-1 text-sm font-semibold text-foreground">{p.title}</h2>
              <p className="text-sm text-muted-foreground">{p.body}</p>
            </li>
          ))}
        </ul>
      </main>
    </>
  )
}
