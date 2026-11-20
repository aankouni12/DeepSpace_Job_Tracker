/**
 * Post-deploy check against the LIVE app (the production bundle), run with
 * tests/playwright.live.config.ts after every `deepspace deploy`.
 *
 * Why it exists: the normal suite runs against the Vite dev server, which
 * never bundles. On 2026-11-19 a deploy built from a lowercase-drive path
 * (Git Bash, `c:\`) bundled `deepspace` twice, so ChatPanel's `useQuery` saw
 * an empty context and the board crashed on "Ask the assistant". Only the
 * production bundle shows that class of bug.
 *
 * Opens the real assistant panel: no mocked routes, no model call.
 */
import { test, expect } from 'deepspace/testing'

test('live: the assistant panel opens on the board without an error screen', async ({ users }) => {
  test.setTimeout(180_000)
  const [user] = await users(['Board Reviewer'])
  const page = user.page
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/board')
  const firstRun = page.getByTestId('first-run')
  const cards = page.getByTestId('application-card')
  await expect(firstRun.or(cards.first())).toBeVisible({ timeout: 30_000 })
  if (await firstRun.isVisible()) {
    // The panel's button is on the board, so it needs data (owner-billed demo sync).
    await page.getByRole('button', { name: 'Try with demo data' }).click()
    await expect(cards.first()).toBeVisible({ timeout: 120_000 })
  }

  await page.getByRole('button', { name: 'Ask the assistant' }).click()
  const panel = page.getByTestId('assistant-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('How can I help?')).toBeVisible()
  await expect(panel.getByRole('textbox')).toBeEditable()
  await expect(page.getByText('Something went wrong')).toHaveCount(0)
  await expect(page.getByTestId('lane-applied')).toBeVisible() // the board is still there
  expect(errors).toEqual([])
})
