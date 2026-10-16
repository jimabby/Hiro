// The app shell: queued questions and submit reviews, the toast stack, the
// notification history, the command palette and the activity log store.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import App from '../../src/App'
import { pushToast, redactSecrets, HISTORY_KEY } from '../../src/toasts'
import { appendLog, getLogs, setLogs } from '../../src/logStore'
import { rankCommands, fuzzyScore } from '../../src/components/CommandPalette'
import { SHORTCUTS } from '../../src/components/ShortcutHelp'

const apps = [
  { id: 41, job_title: 'Platform Engineer', company: 'Globex', platform: 'Seek', status: 'applied', match_score: 90, applied_at: '2026-09-10 01:00:00' },
  { id: 42, job_title: 'Data Analyst', company: 'Initech', platform: 'Seek', status: 'applied', match_score: 80, applied_at: '2026-09-09 01:00:00' },
]

beforeEach(() => {
  setLogs([])
  Object.assign(window.api, {
    getApplications: vi.fn(async () => apps),
    getApplication: vi.fn(async (id) => apps.find(a => a.id === id)),
    getUpcomingInterviews: vi.fn(async () => []),
    getScanInfo: vi.fn(async () => ({ running: false })),
    getAutomationHealth: vi.fn(async () => []),
    getPipeline: vi.fn(async () => ({ items: [], stages: [] })),
    getInterviewPrep: vi.fn(async () => []),
    seekStatus: vi.fn(async () => ({ loggedIn: false })),
    indeedStatus: vi.fn(async () => ({ loggedIn: false })),
    linkedinStatus: vi.fn(async () => ({ loggedIn: false })),
    sendQuestionAnswer: vi.fn(),
    sendSubmitConfirm: vi.fn(),
  })
})

async function openPalette() {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
  const dialog = await screen.findByRole('dialog', { name: 'Command palette' })
  return within(dialog).getByRole('combobox')
}

const paletteOptions = () => within(screen.getByRole('listbox', { name: 'Results' })).getAllByRole('option')

async function renderApp() {
  render(<App />)
  await screen.findByTestId('app-shell')
}

describe('screening questions queue', () => {
  it('keeps a second question instead of overwriting the first', async () => {
    await renderApp()
    act(() => {
      window.api.__emit('question:ask', { id: 1, question: 'Years of Python?' })
      window.api.__emit('question:ask', { id: 2, question: 'Willing to relocate?' })
    })
    expect(await screen.findByText('Years of Python?')).toBeTruthy()
    expect(screen.getByText('1 more waiting after this one')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(/Type your answer/), { target: { value: '5' } })
    fireEvent.click(screen.getByText('Submit Answer'))
    expect(window.api.sendQuestionAnswer).toHaveBeenCalledWith({ id: 1, answer: '5' })

    // The second is now on screen, with an empty answer box.
    expect(await screen.findByText('Willing to relocate?')).toBeTruthy()
    expect(screen.getByPlaceholderText(/Type your answer/).value).toBe('')
    fireEvent.click(screen.getByText('Skip'))
    expect(window.api.sendQuestionAnswer).toHaveBeenLastCalledWith({ id: 2, answer: '' })
    await waitFor(() => expect(screen.queryByText('Application Question')).toBeNull())
  })

  it('closes a question the main process stopped waiting for', async () => {
    await renderApp()
    act(() => {
      window.api.__emit('question:ask', { id: 7, question: 'Notice period?' })
      window.api.__emit('question:ask', { id: 8, question: 'Visa status?' })
    })
    await screen.findByText('Notice period?')
    act(() => window.api.__emit('question:cancel', { id: 7 }))
    expect(await screen.findByText('Visa status?')).toBeTruthy()
    expect(screen.queryByText('Notice period?')).toBeNull()
    act(() => window.api.__emit('question:cancel', { id: 8 }))
    await waitFor(() => expect(screen.queryByText('Application Question')).toBeNull())
    expect(window.api.sendQuestionAnswer).not.toHaveBeenCalled()
  })
})

describe('submit review queue', () => {
  it('queues reviews and drops one that timed out', async () => {
    await renderApp()
    act(() => {
      window.api.__emit('submit:review', { id: 1, platform: 'Seek', screeningQa: [] })
      window.api.__emit('submit:review', { id: 2, platform: 'Indeed', screeningQa: [] })
    })
    expect(await screen.findByText(/on Seek/)).toBeTruthy()
    act(() => window.api.__emit('submit:cancel', { id: 1 }))
    expect(await screen.findByText(/on Indeed/)).toBeTruthy()
    fireEvent.click(screen.getByText('Send application'))
    expect(window.api.sendSubmitConfirm).toHaveBeenCalledWith({ id: 2, approved: true })
    await waitFor(() => expect(screen.queryByText('Send this application?')).toBeNull())
  })
})

describe('toast stack', () => {
  const t = (id, type = 'info', extra = {}) => ({ id, msg: id, type, ...extra })

  it('evicts the oldest transient toast first', () => {
    const next = pushToast([t('a'), t('b'), t('c'), t('d')], t('e'))
    expect(next.map(x => x.id)).toEqual(['b', 'c', 'd', 'e'])
  })

  it('never evicts errors, undo or sticky toasts', () => {
    const prev = [t('err', 'error'), t('undo', 'info', { action: { label: 'Undo' } }), t('sticky', 'info', { sticky: true }), t('plain')]
    const next = pushToast(prev, t('new'))
    expect(next.map(x => x.id)).toEqual(['err', 'undo', 'sticky', 'new'])
    // With nothing evictable left the stack grows rather than dropping one.
    const full = pushToast(next.filter(x => x.id !== 'new').concat(t('err2', 'error')), t('err3', 'error'))
    expect(full.map(x => x.id)).toEqual(['err', 'undo', 'sticky', 'err2', 'err3'])
  })
})

describe('notification history', () => {
  it('lists dismissed notifications with an unread count, persisted without secrets', async () => {
    await renderApp()
    act(() => {
      window.api.__emit('notification', { type: 'backup-drill', report: { success: false, error: 'Upload failed: token=abcd1234efgh5678 rejected' } })
    })
    const toast = await screen.findByText(/Upload failed/)
    fireEvent.click(within(toast.closest('.toast')).getByLabelText('Dismiss notification'))
    await waitFor(() => expect(screen.queryByText(/Upload failed/)).toBeNull())

    const bell = screen.getByRole('button', { name: /Notifications, 1 unread/ })
    fireEvent.click(bell)
    const panel = await screen.findByTestId('notification-history')
    expect(panel.textContent).toMatch(/Upload failed: token=\[redacted\] rejected/)
    expect(panel.textContent).not.toMatch(/abcd1234/)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy())

    const stored = JSON.parse(window.localStorage.getItem(HISTORY_KEY))
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toMatch(/abcd1234/)
  })

  it('masks key-shaped strings', () => {
    expect(redactSecrets('bad key sk-ant-abcdefghijklmnop123')).toBe('bad key [redacted]')
    expect(redactSecrets('Authorization: Bearer abc.def.ghijklmn')).toMatch(/Bearer \[redacted\]/)
    expect(redactSecrets('Scan complete')).toBe('Scan complete')
  })
})

describe('config load failure', () => {
  it('shows an error with a retry instead of a blank window', async () => {
    window.api.getConfig = vi.fn()
      .mockRejectedValueOnce(new Error('config.json is unreadable'))
      .mockResolvedValue({ setupComplete: true, resumes: [], masterResume: 'x' })
    render(<App />)
    expect((await screen.findByTestId('load-error')).textContent).toMatch(/config.json is unreadable/)
    fireEvent.click(screen.getByText('Try again'))
    expect(await screen.findByTestId('app-shell')).toBeTruthy()
  })
})

describe('command palette', () => {
  it('opens with Ctrl+K and navigates to a page', async () => {
    await renderApp()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' })
    const input = within(dialog).getByRole('combobox')
    fireEvent.change(input, { target: { value: 'pipeline' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('nav-pipeline').getAttribute('aria-current')).toBe('page'))
    expect(screen.queryByTestId('command-palette')).toBeNull()
  })

  it('moves the selection with the arrow keys and closes on Escape', async () => {
    await renderApp()
    const input = await openPalette()
    const options = paletteOptions()
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(paletteOptions()[1].getAttribute('aria-selected')).toBe('true')
    expect(input.getAttribute('aria-activedescendant')).toBe(paletteOptions()[1].id)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    // Wraps to the last entry.
    const all = paletteOptions()
    expect(all[all.length - 1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull())
  })

  it('finds an application by company and opens its detail', async () => {
    await renderApp()
    const input = await openPalette()
    await waitFor(() => expect(window.api.getApplications).toHaveBeenCalled())
    fireEvent.change(input, { target: { value: 'initech' } })
    const option = await within(screen.getByRole('listbox', { name: 'Results' })).findByRole('option', { name: /Data Analyst — Initech/ })
    fireEvent.click(option)
    expect(await screen.findByRole('dialog', { name: 'Application detail' })).toBeTruthy()
    await waitFor(() => expect(window.api.getApplication).toHaveBeenCalledWith(42))
  })

  it('starts a scan from an action', async () => {
    window.api.startAutomation = vi.fn(async () => ({ success: true }))
    await renderApp()
    const input = await openPalette()
    fireEvent.change(input, { target: { value: 'start scan' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(window.api.startAutomation).toHaveBeenCalled())
  })

  it('ranks closer matches first', () => {
    const cmds = [{ id: 'a', label: 'Reset filters' }, { id: 'b', label: 'Settings' }, { id: 'c', label: 'Timeline' }]
    expect(rankCommands('set', cmds).map(c => c.id)).toEqual(['b', 'a'])
    expect(fuzzyScore('tln', 'Timeline')).not.toBeNull()
    expect(fuzzyScore('xyz', 'Timeline')).toBeNull()
  })

  it('is listed in the shortcut help', () => {
    expect(SHORTCUTS.some(s => s.keys.join('+') === 'Ctrl+K')).toBe(true)
  })
})

describe('activity log', () => {
  it('keeps log lines out of App state and shows them on the Dashboard', async () => {
    await renderApp()
    act(() => {
      window.api.__emit('automation:log', 'Fetched 12 jobs from Seek')
      window.api.__emit('automation:log', 'Scored 12 jobs')
    })
    expect(getLogs()).toEqual(['Fetched 12 jobs from Seek', 'Scored 12 jobs'])
    expect(await screen.findByText(/Scored 12 jobs/)).toBeTruthy()
    expect(screen.getByText('2 entries')).toBeTruthy()
  })

  it('caps the store', () => {
    for (let i = 0; i < 250; i++) appendLog(`line ${i}`)
    expect(getLogs().length).toBe(201)
    expect(getLogs().at(-1)).toBe('line 249')
  })
})
