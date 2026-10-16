// The Dashboard's application panel: keyboard handling that respects focus,
// interview prep that stays with the application it was made for, and filters
// that survive a restart.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import Dashboard from '../../src/pages/Dashboard'

const A = { id: 1, job_title: 'Platform Engineer', company: 'Globex', platform: 'Seek', status: 'applied', match_score: 90, applied_at: '2026-09-10 01:00:00' }
const B = { id: 2, job_title: 'Data Analyst', company: 'Initech', platform: 'Seek', status: 'applied', match_score: 80, applied_at: '2026-09-09 01:00:00' }

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  Object.assign(window.api, {
    getStats: vi.fn(async () => ({ totalToday: 0, totalThisWeek: 0, totalAllTime: 2, interviews: 0 })),
    getApplications: vi.fn(async () => [A, B]),
    getApplication: vi.fn(async (id) => ({ ...(id === 1 ? A : B), job_description: 'desc' })),
    getUpcomingInterviews: vi.fn(async () => []),
    getScanInfo: vi.fn(async () => ({})),
    getAutomationHealth: vi.fn(async () => []),
    getInterviewPrep: vi.fn(async () => []),
    seekStatus: vi.fn(async () => ({ loggedIn: false })),
    indeedStatus: vi.fn(async () => ({ loggedIn: false })),
    linkedinStatus: vi.fn(async () => ({ loggedIn: false })),
    exportCSV: vi.fn(async () => ({ success: true, count: 1 })),
    updateApplicationComment: vi.fn(async () => ({ success: true })),
  })
})

const renderDash = (props = {}) => render(<Dashboard active scanRunning={false} showToast={() => {}} {...props} />)
const heading = () => screen.getByRole('dialog', { name: 'Application detail' }).querySelector('h2').textContent

async function openA() {
  fireEvent.click(await screen.findByText('Platform Engineer'))
  await screen.findByRole('dialog', { name: 'Application detail' })
}

describe('keyboard handling in the application panel', () => {
  it('does not switch applications with the arrows while typing', async () => {
    renderDash()
    await openA()
    const comment = screen.getByLabelText('Comment')
    comment.focus()
    fireEvent.keyDown(comment, { key: 'ArrowDown' })
    expect(heading()).toBe('Platform Engineer')

    comment.blur()
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    await waitFor(() => expect(heading()).toBe('Data Analyst'))
  })

  it('keeps the panel open on Escape while typing or while another dialog is up', async () => {
    renderDash()
    await openA()
    const comment = screen.getByLabelText('Comment')
    comment.focus()
    fireEvent.keyDown(comment, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Application detail' })).toBeTruthy()
    comment.blur()

    // An App-level dialog, e.g. a screening question.
    const other = document.createElement('div')
    other.setAttribute('aria-modal', 'true')
    document.body.appendChild(other)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Application detail' })).toBeTruthy()
    other.remove()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Application detail' })).toBeNull())
  })
})

describe('interview prep follows the selected application', () => {
  it('drops saved prep that arrives after the user moved on', async () => {
    const prepA = deferred()
    window.api.getInterviewPrep = vi.fn((id) => (id === 1 ? prepA.promise : Promise.resolve([])))
    renderDash()
    await openA()
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    await waitFor(() => expect(heading()).toBe('Data Analyst'))

    await act(async () => { prepA.resolve([{ question: 'Question meant for Globex?', answer: 'a', category: 'technical' }]) })
    expect(screen.queryByText(/Question meant for Globex/)).toBeNull()
  })

  it('drops generated questions for an application that is no longer open, and resets the button on failure', async () => {
    const gen = deferred()
    window.api.getConfig = vi.fn(async () => ({ resumes: [], masterResume: 'r' }))
    window.api.generateInterviewQuestions = vi.fn(() => gen.promise)
    const showToast = vi.fn()
    renderDash({ showToast })
    await openA()
    fireEvent.click(screen.getByText('Interview Questions'))
    await waitFor(() => expect(window.api.generateInterviewQuestions).toHaveBeenCalled())
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    await waitFor(() => expect(heading()).toBe('Data Analyst'))
    await act(async () => { gen.resolve({ success: true, questions: [{ question: 'Generated for Globex?', answer: 'a', category: 'technical' }] }) })
    expect(screen.queryByText(/Generated for Globex/)).toBeNull()

    // A rejection no longer leaves the button stuck on "Generating...".
    window.api.generateInterviewQuestions = vi.fn(async () => { throw new Error('rate limited') })
    fireEvent.click(await screen.findByText('Interview Questions'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/rate limited/), 'error'))
    expect(screen.getByText('Interview Questions')).toBeTruthy()
  })
})

describe('filters and sort', () => {
  it('are remembered across a restart', async () => {
    const { unmount } = renderDash()
    const search = await screen.findByLabelText('Search applications by role or company')
    fireEvent.change(search, { target: { value: 'globex' } })
    unmount()
    renderDash()
    expect((await screen.findByLabelText('Search applications by role or company')).value).toBe('globex')
  })

  it('fall back to defaults when the stored value is unreadable', async () => {
    window.localStorage.setItem('hiro.dashboard.filter', '{not json')
    renderDash()
    expect((await screen.findByLabelText('Search applications by role or company')).value).toBe('')
  })

  it('export passes the search term through', async () => {
    renderDash()
    const search = await screen.findByLabelText('Search applications by role or company')
    fireEvent.change(search, { target: { value: 'globex' } })
    fireEvent.click(screen.getByText('Export CSV'))
    await waitFor(() => expect(window.api.exportCSV).toHaveBeenCalledWith(expect.objectContaining({ search: 'globex' })))
  })
})
