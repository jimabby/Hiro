// Pages load when they are first opened, and stay mounted afterwards.
//
// The renderer shipped as a single 440 KB bundle with all ten pages parsed and
// evaluated before the first frame — including Settings, which is by some
// distance the largest and is opened least often.
//
// The property that had to survive the change is the one several effects in this
// app depend on: pages stay mounted rather than unmounting on navigation, so
// their state, scroll position and subscriptions persist. The comment on the
// Dashboard's scan-info effect says so explicitly ("pages stay mounted, so
// there's no remount to rely on"), and a naive route split would have quietly
// broken every one of them.
//
// So a page enters the mounted set the first time it is opened and never leaves.
// These tests pin both halves: not mounted before, and still mounted after
// navigating away.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from '../../src/App'

beforeEach(() => {
  Object.assign(window.api, {
    getConfig: vi.fn(async () => ({ setupComplete: true, resumes: [], masterResume: 'x' })),
    getApplications: vi.fn(async () => []),
    getOffers: vi.fn(async () => []),
    getHeldApplications: vi.fn(async () => []),
    getAttentionJobs: vi.fn(async () => []),
    getFollowUpReviews: vi.fn(async () => []),
    getPipeline: vi.fn(async () => []),
    getDueNextActions: vi.fn(async () => []),
    getUpcomingInterviews: vi.fn(async () => []),
    getScanInfo: vi.fn(async () => ({ running: false, batchSchedule: [] })),
    getAutomationHealth: vi.fn(async () => []),
    getCampaigns: vi.fn(async () => []),
    getContacts: vi.fn(async () => []),
    getOptimisationInsights: vi.fn(async () => []),
    getCampaignAnalytics: vi.fn(async () => []),
  })
})

const gotoPage = (label) => fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }))

describe('lazy page loading', () => {
  it('mounts only the landing page at startup', async () => {
    render(<App />)
    await screen.findByTestId('app-shell')
    // Workbench has not been opened, so its chunk has not been requested and
    // its data calls have not run.
    expect(window.api.getCampaigns).not.toHaveBeenCalled()
    expect(window.api.getContacts).not.toHaveBeenCalled()
  })

  it('loads a page the first time it is opened', async () => {
    render(<App />)
    await screen.findByTestId('app-shell')
    gotoPage('Workbench')
    await waitFor(() => expect(window.api.getCampaigns).toHaveBeenCalled())
  })

  // The property the rest of the app assumes, tested by the thing that actually
  // demonstrates it: component state survives navigation.
  //
  // Not by counting fetches — these pages deliberately refresh when they become
  // active again, so a refetch on return is correct behaviour and says nothing
  // about whether the component was torn down. Half-typed input surviving does.
  it('keeps a page mounted after navigating away from it', async () => {
    render(<App />)
    await screen.findByTestId('app-shell')

    gotoPage('Workbench')
    const name = await screen.findByLabelText('Campaign name')
    fireEvent.change(name, { target: { value: 'Half-typed campaign' } })

    gotoPage('Dashboard')
    gotoPage('Workbench')

    // Still the same input, still holding what was typed into it. A remount
    // would have reset it to the blank campaign.
    const again = await screen.findByLabelText('Campaign name')
    expect(again.value).toBe('Half-typed campaign')
  })

  it('leaves the nav usable while a chunk resolves', async () => {
    render(<App />)
    await screen.findByTestId('app-shell')
    gotoPage('Analytics')
    // The sidebar is outside every Suspense boundary — one boundary around the
    // whole loop would blank the app while a single chunk loaded.
    expect(screen.getByTestId('nav')).toBeTruthy()
  })
})
