/**
 * The board end to end, as the dedicated "Board Reviewer" test account:
 * first-run screen -> demo data -> cards in the right lanes -> status change
 * persists -> timeline -> delete from Settings -> first-run again -> Connect
 * Gmail with Google mocked via page.route (CLAUDE.md: tests mock Google OAuth).
 *
 * Needs an account with no data that isn't rate-limited: a fresh local state
 * (rm -rf .wrangler/state) or 10 minutes since this spec last ran.
 */
import { test, expect, findTestAccountByName } from 'deepspace/testing'

test.skip(!findTestAccountByName('Board Reviewer'), 'Needs the "Board Reviewer" test account.')

test('first run, demo board, status change, timeline, delete, connect Gmail', async ({ users }, testInfo) => {
  test.setTimeout(180_000)
  const [user] = await users(['Board Reviewer'])
  const page = user.page

  // First run: one sentence and two prominent buttons, not four empty lanes.
  await page.goto('/board')
  const firstRun = page.getByTestId('first-run')
  await expect(firstRun).toBeVisible({ timeout: 20_000 })
  await expect(firstRun.getByText(/reads the replies to your job applications in Gmail/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try with demo data' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect Gmail' })).toBeVisible()
  await expect(page.getByTestId('lane-applied')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('first-run.png'), fullPage: true })

  // Demo data: the three demo applications land in the right lanes.
  await page.getByRole('button', { name: 'Try with demo data' }).click()
  const status = page.getByRole('status').first()
  test.skip(
    await status.getByText('Synced recently').isVisible().catch(() => false),
    'Board Reviewer is rate-limited from a run less than 10 minutes ago.',
  )
  await expect(page.getByTestId('application-card')).toHaveCount(5, { timeout: 120_000 })
  await expect(page.getByTestId('lane-offer').getByText('Northwind Robotics', { exact: true })).toBeVisible()
  // The card shows the company as the first email wrote it ("Cedar Labs Inc.").
  await expect(page.getByTestId('lane-interview').getByText(/^Cedar Labs( Inc\.)?$/)).toBeVisible()
  await expect(page.getByTestId('lane-rejected').getByText('Bluefin Analytics', { exact: true })).toBeVisible()
  await expect(page.getByTestId('lane-applied').getByText('Kestrel Systems', { exact: true })).toBeVisible() // take-home = Applied
  await expect(page.getByTestId('lane-rejected').getByText('Maple Ridge Software', { exact: true })).toBeVisible() // rejection in paragraph 2
  await expect(page.getByTestId('lane-applied').getByTestId('application-card')).toHaveCount(1)
  await expect(page.getByText('Acme')).toHaveCount(0) // demo-9 injection created nothing
  await page.screenshot({ path: testInfo.outputPath('board.png'), fullPage: true })

  // Status change moves the card and survives a reload.
  await page
    .getByTestId('lane-rejected')
    .getByRole('combobox', { name: 'Status for Bluefin Analytics' })
    .selectOption('interview')
  await expect(page.getByTestId('lane-interview').getByText('Bluefin Analytics', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('lane-interview').getByText('Bluefin Analytics', { exact: true })).toBeVisible({ timeout: 20_000 })

  // Timeline: Northwind's three emails, newest first.
  await page.getByTestId('lane-offer').getByRole('button', { name: /Northwind Robotics/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('timeline').locator('li')).toHaveCount(3)
  await expect(dialog.getByTestId('timeline').locator('li').first()).toContainText('sorted as Offer')
  await expect(dialog).toHaveCSS('opacity', '1') // let the open animation finish
  await page.screenshot({ path: testInfo.outputPath('timeline.png') })
  await page.keyboard.press('Escape')

  // Assistant: a status change happens only on Confirm. The model is mocked
  // (page.route on /api/ai/chat) with a reply that calls propose_status_change
  // for Kestrel; the real tool and real write path are used for everything else.
  const kestrelId = await page.evaluate(async () => {
    const { token } = await (await fetch('/api/auth/token', { method: 'POST', credentials: 'include' })).json()
    const r = await fetch('/_deepspace/agent/browser/tools/list_applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ input: {} }),
    })
    const { result } = await r.json()
    return (result.applications as { id: string; company: string }[]).find((a) => a.company === 'Kestrel Systems')!.id
  })
  const sse = (chunks: object[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  let call = 0
  await page.route('**/api/ai/chat', (route) => {
    const toolCallId = `t${++call}`
    return route.fulfill({
      contentType: 'text/event-stream',
      body: sse([
        { type: 'start' },
        { type: 'tool-input-available', toolCallId, toolName: 'propose_status_change', input: { applicationId: kestrelId, status: 'interview' } },
        {
          type: 'tool-output-available',
          toolCallId,
          output: { proposal: { applicationId: kestrelId, company: 'Kestrel Systems', role: 'Backend Developer', from: 'applied', to: 'interview' } },
        },
        { type: 'text-delta', id: 'x', delta: 'I proposed moving Kestrel Systems to Interview. Confirm below.' },
        { type: 'finish' },
      ]),
    })
  })
  await page.getByRole('button', { name: 'Ask the assistant' }).click()
  const panel = page.getByTestId('assistant-panel')
  // The real panel renders (the mock above only answers sends). The dev server
  // can't show bundling bugs; tests/assistant.live.ts checks the deployed bundle.
  await expect(panel.getByText('How can I help?')).toBeVisible()
  await expect(page.getByText('Something went wrong')).toHaveCount(0)
  const ask = async () => {
    await panel.getByRole('textbox').fill('Move Kestrel to Interview')
    await panel.getByRole('button', { name: 'Send message' }).click()
  }
  const kestrel = (lane: string) => page.getByTestId(`lane-${lane}`).getByText('Kestrel Systems', { exact: true })

  await ask()
  const proposal = panel.getByTestId('status-proposal').last()
  await expect(proposal).toContainText('Move Kestrel Systems (Backend Developer) from applied to interview?')
  await expect(panel.getByText('Confirm below.')).toBeVisible()
  await expect(kestrel('applied')).toBeVisible() // proposed, not changed
  await page.screenshot({ path: testInfo.outputPath('assistant-proposal.png') })

  await proposal.getByRole('button', { name: 'Cancel' }).click()
  await expect(proposal).toContainText('Cancelled. Nothing changed.')
  await expect(kestrel('applied')).toBeVisible()

  // A mocked turn is never saved server-side, so the panel's in-flight overlay
  // replaces it on the next send: only the new proposal card is shown.
  await ask()
  const second = panel.getByTestId('status-proposal').last()
  await expect(second.getByRole('button', { name: 'Confirm' })).toBeEnabled()
  await expect(kestrel('applied')).toBeVisible()
  await second.getByRole('button', { name: 'Confirm' }).click()
  await expect(second).toContainText("Done. It's in interview.")
  await expect(kestrel('interview')).toBeVisible()
  await page.reload()
  await expect(kestrel('interview')).toBeVisible({ timeout: 20_000 })
  await page.unroute('**/api/ai/chat')

  // Delete from Settings, then the first-run screen is back.
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Delete my synced data' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete my synced data' }).click()
  await expect(page.getByTestId('delete-result')).toHaveText('Deleted 5 applications and 12 emails.')
  await page.goto('/board')
  await expect(page.getByTestId('first-run')).toBeVisible({ timeout: 20_000 })

  // Connect Gmail, with Google mocked: not connected -> requiresOAuth -> consent tab.
  await page.route('**/api/integrations/status', (route) =>
    route.fulfill({ json: { google: { connected: false, gmailRead: false } } }),
  )
  await page.route('**/api/actions/sync', (route) =>
    route.fulfill({
      json: { success: true, data: { requiresOAuth: true, authUrl: 'https://consent.example/oauth' } },
    }),
  )
  await page.context().route('https://consent.example/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Mock Google consent</p>' }),
  )
  await page.reload()
  const consent = page.context().waitForEvent('page')
  await page.getByRole('button', { name: 'Connect Gmail' }).click()
  expect((await consent).url()).toContain('consent.example/oauth')
  await expect(page.getByText('Finish connecting Gmail in the new tab')).toBeVisible()
})
