// Fixes across the pages: Settings refetch and save, Workbench saves, Analytics
// reloads, Offers failures, Review races and undoable rejects, and moving cards
// on the Pipeline board.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import Settings from '../../src/pages/Settings'
import Workbench from '../../src/pages/Workbench'
import Analytics from '../../src/pages/Analytics'
import Offers from '../../src/pages/Offers'
import Review from '../../src/pages/Review'
import Pipeline from '../../src/pages/Pipeline'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// ─── Settings ──────────────────────────────────────────────────

const baseConfig = {
  setupComplete: true, aiProvider: 'claude', aiApiKey: 'k',
  jobKeywords: 'engineer', jobLocation: 'Sydney', salaryMin: 0, matchThreshold: 80,
  blacklistedCompanies: ['Acme'], resumes: [{ id: 'r1', name: 'General', text: 'resume one' }],
  defaultResumeId: 'r1', applicationProfile: {}, atsBoards: [], webhooks: [],
}

function settingsApi(getConfig) {
  Object.assign(window.api, {
    getConfig,
    saveConfig: vi.fn(async () => ({ success: true })),
    linkedinStatus: vi.fn(async () => ({ loggedIn: false })),
    seekStatus: vi.fn(async () => ({ loggedIn: false })),
    indeedStatus: vi.fn(async () => ({ loggedIn: false })),
    getMobileInfo: vi.fn(async () => ({ enabled: false })),
    cloudStatus: vi.fn(async () => ({ signedIn: false })),
    calendarSyncStatus: vi.fn(async () => ({ connected: false, providers: [] })),
    getEncryptionStatus: vi.fn(async () => ({ enabled: false, keychainAvailable: true, backupCount: 0 })),
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '9.9.9', updateAvailable: false })),
    getProfileFields: vi.fn(async () => []),
    listInterviewAnswers: vi.fn(async () => []),
    describeMailServers: vi.fn(async () => ({ ok: true, providerName: 'Gmail', smtp: { host: 'h', port: 465 }, imap: { host: 'i', port: 993 }, passwordHelp: '' })),
    checkResumeParseable: vi.fn(async () => ({ ok: true })),
    getTrayStatus: vi.fn(async () => ({ available: true })),
  })
}

async function openCriteria() {
  fireEvent.click(await screen.findByRole('tab', { name: 'Job, Resume & Cover Letter' }))
  return screen.findByLabelText('Keywords')
}

describe('Settings', () => {
  it('keeps only the edited field when refetching, so changes made elsewhere survive Save', async () => {
    let cfg = baseConfig
    settingsApi(vi.fn(async () => cfg))
    const { rerender } = render(<Settings active showToast={() => {}} />)
    fireEvent.change(await openCriteria(), { target: { value: 'platform' } })

    // Leave Settings; meanwhile the Dashboard blacklists a company and the
    // location changes on disk.
    rerender(<Settings active={false} showToast={() => {}} />)
    cfg = { ...baseConfig, blacklistedCompanies: ['Acme', 'Initech'], jobLocation: 'Melbourne' }
    rerender(<Settings active showToast={() => {}} />)

    await waitFor(() => expect(document.getElementById('set-f36').value).toBe('Melbourne'))
    expect(screen.getByLabelText('Keywords').value).toBe('platform')

    fireEvent.click(screen.getByText('Save Changes'))
    await waitFor(() => expect(window.api.saveConfig).toHaveBeenCalled())
    const saved = window.api.saveConfig.mock.calls[0][0]
    expect(saved.blacklistedCompanies).toEqual(['Acme', 'Initech'])
    expect(saved.jobKeywords).toBe('platform')
    expect(saved.jobLocation).toBe('Melbourne')
  })

  it('reports a refused save and does not stick on "Saving…"', async () => {
    settingsApi(vi.fn(async () => baseConfig))
    window.api.saveConfig = vi.fn(async () => ({ success: false, error: 'Disk is full' }))
    const showToast = vi.fn()
    render(<Settings active showToast={showToast} />)
    fireEvent.change(await openCriteria(), { target: { value: 'platform' } })
    fireEvent.click(screen.getByText('Save Changes'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Disk is full', 'error'))
    expect(screen.getByText('Save Changes')).toBeTruthy()
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })

  it('recovers from a save that throws', async () => {
    settingsApi(vi.fn(async () => baseConfig))
    window.api.saveConfig = vi.fn(async () => { throw new Error('IPC closed') })
    const showToast = vi.fn()
    render(<Settings active showToast={showToast} />)
    await openCriteria()
    fireEvent.click(screen.getByText('Save Changes'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/IPC closed/), 'error'))
    expect(screen.getByText('Save Changes').closest('button').disabled).toBe(false)
  })
})

// ─── Workbench ─────────────────────────────────────────────────

describe('Workbench', () => {
  beforeEach(() => {
    Object.assign(window.api, {
      getCampaigns: vi.fn(async () => [{ id: 'c1', name: 'Sydney data', keywords: 'data', scheduleTime: '09:00', enabled: true }]),
      getContacts: vi.fn(async () => [{ id: 'p1', name: 'Rita Recruiter', relationship: 'recruiter' }]),
      getDueContacts: vi.fn(async () => []),
      getOptimisationInsights: vi.fn(async () => []),
      getCampaignAnalytics: vi.fn(async () => []),
      getConfig: vi.fn(async () => ({ resumes: [] })),
      saveCampaign: vi.fn(async () => ({ success: false, reason: 'Keywords are required' })),
      saveContact: vi.fn(async () => { throw new Error('database locked') }),
      deleteCampaign: vi.fn(async () => ({ success: true })),
      deleteContact: vi.fn(async () => ({ success: true })),
    })
  })

  it('keeps the campaign form when the save is refused', async () => {
    const showToast = vi.fn()
    render(<Workbench active showToast={showToast} />)
    const name = await screen.findByLabelText('Campaign name')
    fireEvent.change(name, { target: { value: 'Melbourne' } })
    fireEvent.click(screen.getByText('Save campaign'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Keywords are required', 'error'))
    expect(screen.getByLabelText('Campaign name').value).toBe('Melbourne')
  })

  it('reports a contact save that throws and keeps the form', async () => {
    const showToast = vi.fn()
    render(<Workbench active showToast={showToast} />)
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Sam' } })
    fireEvent.click(screen.getByText('Save contact'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('database locked', 'error'))
    expect(screen.getByLabelText('Name').value).toBe('Sam')
  })

  it('asks before deleting a campaign or a contact', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<Workbench active showToast={() => {}} />)
    await screen.findByText('Sydney data')
    const [deleteCampaign, deleteContact] = screen.getAllByText('Delete')
    fireEvent.click(deleteCampaign)
    fireEvent.click(deleteContact)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(window.api.deleteCampaign).not.toHaveBeenCalled()
    expect(window.api.deleteContact).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    fireEvent.click(deleteCampaign)
    await waitFor(() => expect(window.api.deleteCampaign).toHaveBeenCalledWith('c1'))
  })
})

// ─── Analytics ─────────────────────────────────────────────────

describe('Analytics', () => {
  beforeEach(() => {
    Object.assign(window.api, {
      getApplications: vi.fn(async () => []),
      getStats: vi.fn(async () => ({ totalToday: 0, totalThisWeek: 0, totalAllTime: 0, byPlatform: [], byStatus: [] })),
      getConfig: vi.fn(async () => ({ matchThreshold: 70, resumes: [] })),
    })
  })

  const perDay = (n) => [{ date: '2026-10-01', count: n }]
  const summary = () => screen.getByRole('img', { name: /applications submitted per day/i }).getAttribute('aria-label')

  it('reloads each time the page becomes visible again', async () => {
    window.api.getApplicationsPerDay = vi.fn(async () => perDay(1))
    const { rerender } = render(<Analytics active />)
    await waitFor(() => expect(window.api.getApplicationsPerDay).toHaveBeenCalledTimes(1))
    rerender(<Analytics active={false} />)
    rerender(<Analytics active />)
    await waitFor(() => expect(window.api.getApplicationsPerDay).toHaveBeenCalledTimes(2))
  })

  it('ignores a range response that a newer one superseded', async () => {
    const slow = deferred()
    window.api.getApplicationsPerDay = vi.fn(async (days) => (days === 14 ? slow.promise : perDay(days)))
    render(<Analytics active />)
    await waitFor(() => expect(summary()).toMatch(/7 in total/))
    const range = screen.getByLabelText('Time range')
    fireEvent.change(range, { target: { value: '14' } })
    fireEvent.change(range, { target: { value: '30' } })
    await waitFor(() => expect(summary()).toMatch(/30 in total/))
    await act(async () => { slow.resolve(perDay(14)) })
    expect(summary()).toMatch(/30 in total/)
  })
})

// ─── Offers ────────────────────────────────────────────────────

describe('Offers', () => {
  it('says so when the first load fails instead of loading forever', async () => {
    window.api.getOffers = vi.fn()
      .mockRejectedValueOnce(new Error('database locked'))
      .mockResolvedValue({ offers: [] })
    window.api.getApplications = vi.fn(async () => [])
    render(<Offers active showToast={() => {}} />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/database locked/)
    fireEvent.click(screen.getByText('Try again'))
    expect(await screen.findByText('No offers recorded yet')).toBeTruthy()
  })
})

// ─── Review ────────────────────────────────────────────────────

describe('Review', () => {
  const seven = { id: 7, job_title: 'Platform Engineer', company: 'Globex', platform: 'Seek', match_score: 88 }
  const eight = { id: 8, job_title: 'Data Analyst', company: 'Initech', platform: 'Seek', match_score: 81 }

  beforeEach(() => {
    Object.assign(window.api, {
      getHeldApplications: vi.fn(async () => [seven, eight]),
      getFollowUpDrafts: vi.fn(async () => []),
      getApplication: vi.fn(async (id) => (id === 7 ? seven : eight)),
      getHoldExplanation: vi.fn(async () => ({ flags: [], diff: [], hasBase: false })),
    })
  })

  it('does not show one draft\'s flags on another opened after it', async () => {
    const holdSeven = deferred()
    window.api.getHoldExplanation = vi.fn((id) => (id === 7
      ? holdSeven.promise
      : Promise.resolve({ flags: [], diff: [], hasBase: false })))
    render(<Review active showToast={() => {}} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Platform Engineer' }))[0])
    fireEvent.click((await screen.findAllByRole('button', { name: 'Data Analyst' }))[0])
    const dialog = await screen.findByRole('dialog', { name: 'Draft detail' })
    await waitFor(() => expect(within(dialog).getByText('Data Analyst')).toBeTruthy())
    await act(async () => { holdSeven.resolve({ flags: [{ kind: 'credential', value: 'ONLY-FOR-SEVEN' }], diff: [], hasBase: true }) })
    expect(screen.queryByText(/ONLY-FOR-SEVEN/)).toBeNull()
  })

  it('offers Undo after a reject and restores the draft', async () => {
    window.api.rejectHeldApplication = vi.fn(async () => ({ success: true, undo: { token: 'tok-1', label: 'Draft rejected' } }))
    window.api.undoRejectHeldApplication = vi.fn(async () => ({ success: true }))
    const showToast = vi.fn()
    render(<Review active showToast={showToast} />)
    await screen.findAllByRole('button', { name: 'Platform Engineer' })
    fireEvent.click(screen.getAllByText('Reject')[0])
    fireEvent.click(await screen.findByText('Reject draft'))
    await waitFor(() => expect(window.api.rejectHeldApplication).toHaveBeenCalledWith(7))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Draft rejected', 'info', expect.objectContaining({ label: 'Undo' })))

    const action = showToast.mock.calls.find(c => c[2]?.label === 'Undo')[2]
    await act(async () => { await action.onAction() })
    expect(window.api.undoRejectHeldApplication).toHaveBeenCalledWith('tok-1')
    expect(showToast).toHaveBeenCalledWith('Draft restored to the review queue', 'success')
  })
})

// ─── Pipeline ──────────────────────────────────────────────────

describe('Pipeline', () => {
  const stages = [
    { id: 'applied', label: 'Applied' }, { id: 'waiting', label: 'No reply yet' },
    { id: 'interview', label: 'Interviewing' }, { id: 'offer', label: 'Offer' }, { id: 'closed', label: 'Closed' },
  ]
  const item = { id: 5, job_title: 'Platform Engineer', company: 'Globex', platform: 'Seek', status: 'applied', stage: 'applied' }

  beforeEach(() => {
    Object.assign(window.api, {
      getPipeline: vi.fn(async () => ({ items: [item], stages, today: '2026-10-16' })),
      updateApplicationStatus: vi.fn(async () => ({ success: true })),
    })
  })

  it('moves a card when it is dropped on another stage', async () => {
    render(<Pipeline active onOpenApplication={() => {}} showToast={() => {}} />)
    const card = await screen.findByRole('button', { name: 'Open Platform Engineer at Globex' })
    expect(card.getAttribute('draggable')).toBe('true')
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => '5'), effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(card, { dataTransfer })
    const target = screen.getByTestId('pipeline-stage-interview')
    fireEvent.dragOver(target, { dataTransfer })
    fireEvent.drop(target, { dataTransfer })
    await waitFor(() => expect(window.api.updateApplicationStatus).toHaveBeenCalledWith(5, 'interview'))
  })

  it('offers a "Move to…" menu as the keyboard alternative', async () => {
    render(<Pipeline active onOpenApplication={() => {}} showToast={() => {}} />)
    const menu = await screen.findByLabelText('Move Platform Engineer at Globex to another stage')
    expect([...menu.options].map(o => o.value)).toEqual(['', 'no_response', 'interview', 'offer', 'rejected', 'withdrawn'])
    fireEvent.change(menu, { target: { value: 'withdrawn' } })
    await waitFor(() => expect(window.api.updateApplicationStatus).toHaveBeenCalledWith(5, 'withdrawn'))
    expect(await screen.findByText(/Moved Platform Engineer to Closed — withdrawn/)).toBeTruthy()
  })

  it('reports a move the main process refused', async () => {
    window.api.updateApplicationStatus = vi.fn(async () => ({ success: false, reason: 'row is locked' }))
    const showToast = vi.fn()
    render(<Pipeline active onOpenApplication={() => {}} showToast={showToast} />)
    fireEvent.change(await screen.findByLabelText(/Move Platform Engineer/), { target: { value: 'offer' } })
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/row is locked/), 'error'))
  })
})
