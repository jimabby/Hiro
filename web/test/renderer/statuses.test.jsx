// Every status the database can hold must have a label.
//
// The badge maps used to live inline in Dashboard.jsx and Timeline.jsx, as two
// copies that had already drifted: `withdrawn` was in neither and `held` in only
// one. Both pages fall back to the raw column value, so those rendered as bare
// lowercase text in a grey badge — the status added specifically to stop an
// outcome being misreported was the one that looked like a bug.
//
// This pins the vocabulary to what the DATABASE accepts, so adding a status
// server-side without giving it a label fails here rather than on screen.

import { describe, it, expect } from 'vitest'
import { STATUS_BADGE, statusBadge, SETTABLE_STATUSES, FILTER_TABS } from '../../src/statuses'

// Mirrors VALID_STATUSES in electron/services/mobileApi.js — the widest set any
// writer in the app may store.
const STORABLE = [
  'applied', 'interview', 'rejected', 'offer',
  'pending', 'no_response', 'skipped', 'held', 'withdrawn',
]

describe('status vocabulary', () => {
  it.each(STORABLE)('%s has a label and a badge colour', (status) => {
    expect(STATUS_BADGE[status]).toBeDefined()
    expect(STATUS_BADGE[status].label).toBeTruthy()
    expect(STATUS_BADGE[status].color).toMatch(/^badge-/)
  })

  it('labels withdrawn rather than showing the raw value', () => {
    expect(statusBadge('withdrawn').label).toBe('Withdrawn')
  })

  it('does not colour withdrawn like a rejection', () => {
    // Withdrawing is not being rejected, and the whole point of the status is
    // that it stops attributing the ending to the employer.
    expect(statusBadge('withdrawn').color).not.toBe(statusBadge('rejected').color)
  })

  it('keeps an unknown status readable instead of blank', () => {
    expect(statusBadge('some_future_status').label).toBe('some_future_status')
    expect(statusBadge('some_future_status').color).toBe('badge-gray')
    expect(statusBadge(undefined).label).toBe('Unknown')
  })

  it('offers withdrawn as a manual choice', () => {
    expect(SETTABLE_STATUSES.map(s => s.value)).toContain('withdrawn')
  })

  it('never offers a scan-assigned status as a manual choice', () => {
    // Both are outcomes of the automation, not claims a person makes.
    expect(SETTABLE_STATUSES.map(s => s.value)).not.toContain('skipped')
    expect(SETTABLE_STATUSES.map(s => s.value)).not.toContain('held')
  })

  it('can filter on every storable status', () => {
    const tabs = FILTER_TABS.map(t => t.value)
    expect(tabs[0]).toBe('') // "All" leads
    for (const status of STORABLE) expect(tabs).toContain(status)
  })
})
