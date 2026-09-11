// The first-run checklist on the Dashboard.
//
// Its two promises: a tick means the step really is done by the same test the
// scan applies, and it disappears once it has nothing left to say.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Dashboard from '../../src/pages/Dashboard'
import { deriveSteps } from '../../src/components/GettingStarted'

const sessions = (over = {}) => ({ Seek: false, Indeed: false, LinkedIn: false, ...over })

describe('deriveSteps', () => {
  it('reports nothing done on an empty config', () => {
    const steps = deriveSteps({ cfg: {}, sessions: sessions() }, false)
    expect(steps.map(s => s.done)).toEqual([false, false, false, false])
  })

  it('counts a resume from either the list or the legacy master text', () => {
    expect(deriveSteps({ cfg: { resumes: [{ id: '1' }] }, sessions: sessions() }, false)[0].done).toBe(true)
    expect(deriveSteps({ cfg: { masterResume: 'text' }, sessions: sessions() }, false)[0].done).toBe(true)
    expect(deriveSteps({ cfg: { masterResume: '   ' }, sessions: sessions() }, false)[0].done).toBe(false)
  })

  it('accepts a local model without an API key', () => {
    const cfg = { aiProvider: 'local', localAiBaseUrl: 'http://localhost:11434/v1', localAiModel: 'llama3.1:8b' }
    expect(deriveSteps({ cfg, sessions: sessions() }, false)[1].done).toBe(true)
    expect(deriveSteps({ cfg: { aiProvider: 'local', localAiBaseUrl: 'x' }, sessions: sessions() }, false)[1].done).toBe(false)
  })

  it('requires a key for a hosted provider', () => {
    expect(deriveSteps({ cfg: { aiProvider: 'claude' }, sessions: sessions() }, false)[1].done).toBe(false)
    expect(deriveSteps({ cfg: { aiProvider: 'claude', aiApiKey: 'sk' }, sessions: sessions() }, false)[1].done).toBe(true)
  })

  it('treats an enabled platform with no session as not ready', () => {
    const step = deriveSteps({ cfg: { enableSeek: true }, sessions: sessions() }, false)[2]
    expect(step.done).toBe(false)
    expect(step.hint).toMatch(/Seek.*not logged in/)
  })

  it('is satisfied by one logged-in platform', () => {
    const step = deriveSteps({ cfg: { enableSeek: true, enableLinkedIn: true }, sessions: sessions({ Seek: true }) }, false)[2]
    expect(step.done).toBe(true)
    // ...but says which enabled platforms will be skipped.
    expect(step.hint).toMatch(/LinkedIn/)
  })

  it('is satisfied by a career board with no platform at all', () => {
    const step = deriveSteps({ cfg: { atsBoards: [{ provider: 'greenhouse', slug: 'x' }] }, sessions: sessions() }, false)[2]
    expect(step.done).toBe(true)
    expect(step.hint).toMatch(/1 career board/)
  })
})

describe('GettingStarted on the Dashboard', () => {
  const baseApi = () => ({
    getStats: vi.fn(async () => ({ totalToday: 0, totalThisWeek: 0, totalAllTime: 0, interviews: 0 })),
    getApplications: vi.fn(async () => []),
    getUpcomingInterviews: vi.fn(async () => []),
    getScanInfo: vi.fn(async () => ({})),
    getAutomationHealth: vi.fn(async () => []),
    seekStatus: vi.fn(async () => ({ loggedIn: false })),
    indeedStatus: vi.fn(async () => ({ loggedIn: false })),
    linkedinStatus: vi.fn(async () => ({ loggedIn: false })),
  })

  beforeEach(() => {
    window.localStorage.clear()
  })

  it('shows when there is no history and steps remain', async () => {
    Object.assign(window.api, baseApi(), {
      getConfig: vi.fn(async () => ({ aiProvider: 'claude', enableSeek: true })),
    })
    const onNavigate = vi.fn()
    render(<Dashboard active logs={[]} scanRunning={false} onNavigate={onNavigate} showToast={() => {}} />)
    const card = await screen.findByTestId('getting-started')
    expect(card.textContent).toMatch(/4 of 4 left/)

    fireEvent.click(screen.getAllByRole('button', { name: 'Open Settings' })[0])
    expect(onNavigate).toHaveBeenCalledWith('settings')
  })

  it('runs a test scan from the last step', async () => {
    Object.assign(window.api, baseApi(), {
      getConfig: vi.fn(async () => ({})),
    })
    const onDryRun = vi.fn()
    render(<Dashboard active logs={[]} scanRunning={false} onDryRun={onDryRun} showToast={() => {}} />)
    await screen.findByTestId('getting-started')
    fireEvent.click(screen.getByRole('button', { name: 'Run Test Scan' }))
    expect(onDryRun).toHaveBeenCalled()
  })

  it('is gone once every step is done', async () => {
    Object.assign(window.api, baseApi(), {
      getConfig: vi.fn(async () => ({
        aiProvider: 'claude', aiApiKey: 'k', resumes: [{ id: '1' }], enableSeek: true,
      })),
      seekStatus: vi.fn(async () => ({ loggedIn: true })),
      getScanInfo: vi.fn(async () => ({ lastScanAt: '2026-09-11T00:00:00Z' })),
    })
    render(<Dashboard active logs={[]} scanRunning={false} showToast={() => {}} />)
    // Let the fetches settle, then assert absence.
    await waitFor(() => expect(window.api.seekStatus).toHaveBeenCalled())
    await waitFor(() => expect(window.api.getScanInfo).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByTestId('getting-started')).toBeNull()
  })

  it('is gone once there is history', async () => {
    Object.assign(window.api, baseApi(), {
      getConfig: vi.fn(async () => ({})),
      getApplications: vi.fn(async () => [{ id: 1, job_title: 'Dev', company: 'Acme', platform: 'Seek', status: 'applied', match_score: 90, applied_at: '2026-09-10 01:00:00' }]),
    })
    render(<Dashboard active logs={[]} scanRunning={false} showToast={() => {}} />)
    await screen.findByText('Dev')
    expect(screen.queryByTestId('getting-started')).toBeNull()
  })

  it('stays hidden after being dismissed', async () => {
    Object.assign(window.api, baseApi(), { getConfig: vi.fn(async () => ({})) })
    render(<Dashboard active logs={[]} scanRunning={false} showToast={() => {}} />)
    await screen.findByTestId('getting-started')
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    await waitFor(() => expect(screen.queryByTestId('getting-started')).toBeNull())
    expect(window.localStorage.getItem('gettingStartedDismissed')).toBe('1')
  })
})
