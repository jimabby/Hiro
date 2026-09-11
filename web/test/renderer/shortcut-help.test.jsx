// The keyboard shortcut list, and the one rule it must obey: while it is open,
// the shortcuts it documents must not fire behind it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from '../../src/App'

beforeEach(() => {
  Object.assign(window.api, {
    getConfig: vi.fn(async () => ({ setupComplete: true, resumes: [], masterResume: 'x' })),
    getApplications: vi.fn(async () => []),
    getUpcomingInterviews: vi.fn(async () => []),
    getScanInfo: vi.fn(async () => ({ running: false })),
    getAutomationHealth: vi.fn(async () => []),
    getPipeline: vi.fn(async () => ({ items: [], stages: [] })),
    seekStatus: vi.fn(async () => ({ loggedIn: false })),
    indeedStatus: vi.fn(async () => ({ loggedIn: false })),
    linkedinStatus: vi.fn(async () => ({ loggedIn: false })),
  })
})

describe('shortcut help', () => {
  it('opens with "?" and closes with Escape', async () => {
    render(<App />)
    await screen.findByTestId('app-shell')
    expect(screen.queryByTestId('shortcut-help')).toBeNull()

    fireEvent.keyDown(window, { key: '?' })
    expect(await screen.findByTestId('shortcut-help')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('shortcut-help')).toBeNull())
  })

  it('opens from the sidebar button', async () => {
    render(<App />)
    await screen.findByTestId('app-shell')
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    expect(await screen.findByTestId('shortcut-help')).toBeTruthy()
  })

  it('does not switch pages while it is open', async () => {
    render(<App />)
    await screen.findByTestId('app-shell')
    fireEvent.keyDown(window, { key: '?' })
    await screen.findByTestId('shortcut-help')

    fireEvent.keyDown(window, { key: '2' })
    // Pipeline would have been fetched had the shortcut fired.
    expect(window.api.getPipeline).not.toHaveBeenCalled()
    expect(screen.getByTestId('nav-dashboard').getAttribute('aria-current')).toBe('page')
  })

  it('does not open while typing in a field', async () => {
    render(<App />)
    await screen.findByTestId('app-shell')
    const search = await screen.findByLabelText('Search applications by role or company')
    search.focus()
    fireEvent.keyDown(search, { key: '?' })
    expect(screen.queryByTestId('shortcut-help')).toBeNull()
  })
})
