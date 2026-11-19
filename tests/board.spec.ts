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
  await expect(page.getByTestId('application-card')).toHaveCount(3, { timeout: 90_000 })
  await expect(page.getByTestId('lane-offer').getByText('Northwind Robotics', { exact: true })).toBeVisible()
  // The card shows the company as the first email wrote it ("Cedar Labs Inc.").
  await expect(page.getByTestId('lane-interview').getByText(/^Cedar Labs( Inc\.)?$/)).toBeVisible()
  await expect(page.getByTestId('lane-rejected').getByText('Bluefin Analytics', { exact: true })).toBeVisible()
  await expect(page.getByTestId('lane-applied').getByTestId('application-card')).toHaveCount(0)
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

  // Delete from Settings, then the first-run screen is back.
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Delete my synced data' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete my synced data' }).click()
  await expect(page.getByTestId('delete-result')).toHaveText('Deleted 3 applications and 10 emails.')
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
