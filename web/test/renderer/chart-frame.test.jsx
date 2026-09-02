// The frame every Analytics chart sits in.
//
// An SVG is a picture. To a screen reader the four charts on that page were
// nothing at all — no name, no description, no content — so Analytics, which is
// almost entirely charts, read as a page of empty boxes. That is the whole
// value of the page being unavailable, not a rough edge on it.
//
// The frame fixes that and a second thing at once: it puts the numbers behind
// each chart one click away as a real table, which is the accessible
// alternative, the way to check a bar you are unsure of, and the export people
// previously had to re-derive from the applications CSV.
//
// The property that matters most here is that the picture and the table are fed
// from one `rows` prop and therefore cannot disagree. A data table that drifts
// from the chart above it is worse than no data table.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import Analytics from '../../src/pages/Analytics'

const PER_DAY = [
  { date: '2026-03-02', count: 3 },
  { date: '2026-03-03', count: 0 },
  { date: '2026-03-04', count: 5 },
]

const APPS = [
  { id: 1, status: 'applied', platform: 'Seek', match_score: 85, applied_at: '2026-03-04 09:00:00' },
  { id: 2, status: 'interview', platform: 'Seek', match_score: 91, applied_at: '2026-03-04 10:00:00' },
  { id: 3, status: 'rejected', platform: 'LinkedIn', match_score: 62, applied_at: '2026-03-02 09:00:00' },
]

beforeEach(() => {
  Object.assign(window.api, {
    getApplications: vi.fn(async () => APPS),
    getStats: vi.fn(async () => ({
      totalToday: 2, totalThisWeek: 3, totalAllTime: 3, attentionCount: 0,
      responseRate: 33, interviewRate: 33,
      byPlatform: [{ platform: 'Seek', count: 2 }, { platform: 'LinkedIn', count: 1 }],
      byStatus: [{ status: 'applied', count: 1 }, { status: 'interview', count: 1 }, { status: 'rejected', count: 1 }],
    })),
    getApplicationsPerDay: vi.fn(async () => PER_DAY),
    getConfig: vi.fn(async () => ({ setupComplete: true, matchThreshold: 70, resumes: [] })),
    getSalaryStats: vi.fn(async () => ({ parsed: 0, unparsed: 0 })),
    getScoreBandConversion: vi.fn(async () => []),
    getResumeConversion: vi.fn(async () => []),
    getThresholdAdvice: vi.fn(async () => ({ available: false })),
    getThresholdRecommendation: vi.fn(async () => null),
    getAiUsageSummary: vi.fn(async () => ({ day: {}, month: {}, byOperation: [] })),
    getGhostListings: vi.fn(async () => []),
    getRejectionAnalysis: vi.fn(async () => ({ insights: [], byResume: [], byBand: [] })),
    getVersionOutcomes: vi.fn(async () => []),
    getResumeExperiment: vi.fn(async () => ({ running: false })),
  })
  // jsdom implements neither, and the CSV export touches both.
  window.URL.createObjectURL = vi.fn(() => 'blob:fake')
  window.URL.revokeObjectURL = vi.fn()
})

const renderPage = async () => {
  const view = render(<Analytics active />)
  await screen.findByText(/Applications — Last/i)
  return view
}

describe('chart accessibility', () => {
  it('gives every chart an accessible name', async () => {
    await renderPage()
    const charts = screen.getAllByRole('img')
    expect(charts.length).toBeGreaterThanOrEqual(3)
    for (const chart of charts) {
      expect(chart.getAttribute('aria-label')).toBeTruthy()
    }
  })

  // The name has to carry the numbers, not just say "a chart". A label of
  // "bar chart" tells a screen-reader user exactly as much as the empty box did.
  it('summarises the data in the name rather than naming the chart type', async () => {
    await renderPage()
    const daily = screen.getByRole('img', { name: /applications submitted per day/i })
    expect(daily.getAttribute('aria-label')).toMatch(/8 in total/)
    expect(daily.getAttribute('aria-label')).toMatch(/highest 5 in a day/)
  })

  it('names the platform breakdown with its actual counts', async () => {
    await renderPage()
    const platform = screen.getByRole('img', { name: /applications by platform/i })
    expect(platform.getAttribute('aria-label')).toMatch(/Seek 2/)
    expect(platform.getAttribute('aria-label')).toMatch(/LinkedIn 1/)
  })
})

describe('chart data tables', () => {
  it('hides the table until it is asked for', async () => {
    await renderPage()
    expect(screen.queryByRole('table', { name: /Applications, last/i })).toBeNull()
  })

  it('opens the table and reports it as expanded', async () => {
    await renderPage()
    const [toggle] = screen.getAllByRole('button', { name: 'Show data' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  // The point of the table: the same numbers as the picture, from the same
  // prop, so the two cannot drift.
  it('shows the chart data as rows', async () => {
    await renderPage()
    fireEvent.click(screen.getAllByRole('button', { name: 'Show data' })[0])
    const table = screen.getByRole('table', { name: /Applications, last/i })
    const rows = within(table).getAllByRole('row').slice(1) // drop the header
    expect(rows).toHaveLength(PER_DAY.length)
    expect(within(rows[0]).getByRole('rowheader').textContent).toBe('2026-03-02')
    expect(rows[0].textContent).toContain('3')
    expect(rows[2].textContent).toContain('5')
  })

  it('gives the table column headers', async () => {
    await renderPage()
    fireEvent.click(screen.getAllByRole('button', { name: 'Show data' })[0])
    const table = screen.getByRole('table', { name: /Applications, last/i })
    const headers = within(table).getAllByRole('columnheader').map(h => h.textContent)
    expect(headers).toEqual(['Date', 'Applications'])
  })

  // aria-describedby only helps if it resolves to something in the document.
  it('points the chart at the table once it is open', async () => {
    await renderPage()
    fireEvent.click(screen.getAllByRole('button', { name: 'Show data' })[0])
    const chart = screen.getByRole('img', { name: /applications submitted per day/i })
    const described = chart.getAttribute('aria-describedby')
    expect(described).toBeTruthy()
    expect(document.getElementById(described)).not.toBeNull()
  })
})

describe('chart CSV export', () => {
  it('offers an export for every chart with data', async () => {
    await renderPage()
    expect(screen.getAllByRole('button', { name: 'Export CSV' }).length).toBeGreaterThanOrEqual(3)
  })

  it('builds a downloadable file rather than navigating', async () => {
    await renderPage()
    const clicks = []
    const realClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function patched() { clicks.push({ href: this.href, download: this.download }) }
    try {
      fireEvent.click(screen.getAllByRole('button', { name: 'Export CSV' })[0])
    } finally {
      HTMLAnchorElement.prototype.click = realClick
    }
    expect(clicks).toHaveLength(1)
    expect(clicks[0].download).toBe('hiro-applications-per-day-7d.csv')
    expect(window.URL.createObjectURL).toHaveBeenCalled()
  })
})
