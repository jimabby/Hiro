// Settings has the most controls of any page and was the one form-labels.test
// did not cover. It is also the page where the failure it guards against was
// actually present: ids inside .map() loops — one per webhook, one per daily
// limit, one per A/B slot — were literal strings, so three controls shared an
// id and every label pointed at the first of them.
//
// Every tab is visited, because a control on a tab that is not open is not in
// the DOM and cannot be checked.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import Settings from '../../src/pages/Settings'

const config = {
  setupComplete: true,
  aiProvider: 'claude', aiApiKey: 'k',
  gmailAddress: 'me@example.com', gmailAppPassword: 'p',
  jobKeywords: 'engineer', jobLocation: 'Sydney', salaryMin: 0, matchThreshold: 80,
  enableSeek: true, enableIndeed: true, enableLinkedIn: true,
  dailyLimitSeek: 10, dailyLimitIndeed: 10, dailyLimitLinkedIn: 10,
  blacklistedCompanies: ['Acme'],
  resumes: [
    { id: 'r1', name: 'General', text: 'resume one' },
    { id: 'r2', name: 'Data', text: 'resume two' },
  ],
  defaultResumeId: 'r1',
  resumeRules: [{ id: 'rule1', keywords: 'data', resumeId: 'r2' }],
  resumeExperiment: { enabled: true, name: 'A vs B', resumeA: 'r1', resumeB: 'r2' },
  // Two webhooks, so a shared id would collide.
  webhooks: [
    { provider: 'discord', url: 'https://a', enabled: true },
    { provider: 'slack', url: 'https://b', enabled: true },
  ],
  enableInboxCheck: true, enableFollowUp: true, followUpMaxCount: 2,
  enableSmartScheduling: true, pushEnabled: true, reviewBeforeSubmit: true,
  applicationProfile: {}, atsBoards: [],
}

function unnamedControls(container) {
  return [...container.querySelectorAll('input, select, textarea')].filter((el) => {
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return false
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return false
    if (el.id && container.querySelector(`label[for="${el.id}"]`)) return false
    if (el.closest('label')) return false
    return true
  })
}

const describeControl = (el) =>
  `<${el.tagName.toLowerCase()}${el.type ? ` type="${el.type}"` : ''}${el.placeholder ? ` placeholder="${el.placeholder}"` : ''}>`

beforeEach(() => {
  Object.assign(window.api, {
    getConfig: vi.fn(async () => config),
    linkedinStatus: vi.fn(async () => ({ loggedIn: false })),
    seekStatus: vi.fn(async () => ({ loggedIn: false })),
    indeedStatus: vi.fn(async () => ({ loggedIn: false })),
    getMobileInfo: vi.fn(async () => ({ enabled: false })),
    cloudStatus: vi.fn(async () => ({ signedIn: false })),
    calendarSyncStatus: vi.fn(async () => ({ connected: false, providers: [{ id: 'google', label: 'Google', consoleUrl: 'https://x', needsSecret: true }] })),
    getEncryptionStatus: vi.fn(async () => ({ enabled: false, keychainAvailable: true, backupCount: 0 })),
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '9.9.9', updateAvailable: false })),
    getProfileFields: vi.fn(async () => [{ id: 'phone', label: 'Phone', help: '04…' }]),
    listInterviewAnswers: vi.fn(async () => []),
    listBackups: vi.fn(async () => []),
    getBackupDrillStatus: vi.fn(async () => null),
    getStorageInfo: vi.fn(async () => ({ dbSize: 0, counts: { applications: 0, attentionJobs: 0, cachedAnswers: 0, interviewPreps: 0 } })),
    describeMailServers: vi.fn(async () => ({ ok: true, providerName: 'Gmail', smtp: { host: 'h', port: 465 }, imap: { host: 'i', port: 993 }, passwordHelp: '' })),
    checkResumeParseable: vi.fn(async () => ({ ok: true })),
    getTrayStatus: vi.fn(async () => ({ available: true })),
  })
})

const TABS = ['Accounts & Schedule', 'Job, Resume & Cover Letter', 'Automation & Boards', 'Notifications', 'Data Management', 'About']

async function openTab(getByRole, label) {
  fireEvent.click(getByRole('tab', { name: label }))
}

describe('Settings form controls', () => {
  it('names every control on every tab', async () => {
    const { container, findByRole, getByRole } = render(<Settings active showToast={() => {}} />)
    await findByRole('heading', { name: /^settings$/i })
    const failures = {}
    for (const tab of TABS) {
      await openTab(getByRole, tab)
      await waitFor(() => expect(getByRole('tab', { name: tab }).getAttribute('aria-selected')).toBe('true'))
      const unnamed = unnamedControls(container).map(describeControl)
      if (unnamed.length) failures[tab] = unnamed
    }
    expect(failures).toEqual({})
  })

  it('never repeats an id, on any tab', async () => {
    const { container, findByRole, getByRole } = render(<Settings active showToast={() => {}} />)
    await findByRole('heading', { name: /^settings$/i })
    for (const tab of TABS) {
      await openTab(getByRole, tab)
      await waitFor(() => expect(getByRole('tab', { name: tab }).getAttribute('aria-selected')).toBe('true'))
      const ids = [...container.querySelectorAll('[id]')].map(el => el.id)
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
      expect(dupes, `duplicate ids on "${tab}"`).toEqual([])
    }
  })

  it('every htmlFor resolves to a control, on any tab', async () => {
    const { container, findByRole, getByRole } = render(<Settings active showToast={() => {}} />)
    await findByRole('heading', { name: /^settings$/i })
    for (const tab of TABS) {
      await openTab(getByRole, tab)
      await waitFor(() => expect(getByRole('tab', { name: tab }).getAttribute('aria-selected')).toBe('true'))
      const dangling = [...container.querySelectorAll('label[for]')]
        .map(l => l.getAttribute('for'))
        .filter(id => !container.querySelector(`[id="${id}"]`))
      expect(dangling, `dangling labels on "${tab}"`).toEqual([])
    }
  })

  // The About tab used to say "Version 1.0.0" as a literal.
  it('shows the running version from the updater', async () => {
    const { findByRole, getByRole, findByText } = render(<Settings active showToast={() => {}} />)
    await findByRole('heading', { name: /^settings$/i })
    await openTab(getByRole, 'About')
    await findByText('Version 9.9.9')
  })
})

describe('Settings → Data clears offer undo', () => {
  it('offers to undo clearing the application history', async () => {
    const showToast = vi.fn()
    window.confirm = vi.fn(() => true)
    window.api.clearAllApplications = vi.fn(async () => ({ success: true, undo: { token: 't1', label: '12 applications deleted' } }))
    const { findByRole, getByRole, findAllByRole } = render(<Settings active showToast={showToast} />)
    await findByRole('heading', { name: /^settings$/i })
    await openTab(getByRole, 'Data Management')
    const buttons = await findAllByRole('button', { name: 'Clear All' })
    fireEvent.click(buttons[0])
    await waitFor(() => expect(window.api.clearAllApplications).toHaveBeenCalled())
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      '12 applications deleted', 'info', expect.objectContaining({ label: 'Undo' }),
    ))
  })
})
