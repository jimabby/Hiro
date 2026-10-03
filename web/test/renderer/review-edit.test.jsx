import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor, screen, within } from '@testing-library/react'
import Review from '../../src/pages/Review'
import { exportCsv } from '../../src/exportCsv'

// Editing a held draft, and stopping a bulk approval.
//
// Approve-or-reject used to be the whole choice, so a draft the fabrication
// guard stopped over a single invented line had to be thrown away and paid for
// again. And a twenty-draft approval, spaced minutes apart, had no way out.

const row = { id: 7, job_title: 'Platform Engineer', company: 'Globex', platform: 'Seek', match_score: 88 }
const full = { ...row, tailored_resume: 'Jane\nAWS Certified', cover_letter: 'Dear Globex' }

beforeEach(() => {
  Object.assign(window.api, {
    getHeldApplications: vi.fn(async () => [row, { ...row, id: 8, company: 'Initech' }]),
    getFollowUpDrafts: vi.fn(async () => []),
    getApplication: vi.fn(async () => full),
    getHoldExplanation: vi.fn(async () => ({ flags: [{ kind: 'credential', value: 'AWS Certified' }], diff: [], hasBase: true })),
    editHeldDraft: vi.fn(async () => ({ success: true, flags: [] })),
    approveHeldApplication: vi.fn(async () => ({ success: true })),
    approveHeldApplications: vi.fn(() => new Promise(() => {})),
    cancelBulkApply: vi.fn(async () => ({ success: true })),
  })
})

describe('Review — editing a held draft', () => {
  it('saves the edited documents and re-checks them', async () => {
    const showToast = vi.fn()
    render(<Review active showToast={showToast} />)
    const [title] = await screen.findAllByRole('button', { name: 'Platform Engineer' })
    fireEvent.click(title)
    fireEvent.click(await screen.findByText('Edit documents'))

    const resume = screen.getByLabelText('Tailored resume')
    expect(resume.value).toBe('Jane\nAWS Certified')
    fireEvent.change(resume, { target: { value: 'Jane' } })
    fireEvent.change(screen.getByLabelText('Cover letter'), { target: { value: 'Dear Globex team' } })

    // Approving an unsaved edit would send the old text — so it is blocked.
    const dialog = () => within(screen.getByRole('dialog', { name: 'Draft detail' }))
    expect(dialog().getByText('Approve & submit').closest('button').disabled).toBe(true)

    fireEvent.click(screen.getByText('Save edit'))
    await waitFor(() => expect(window.api.editHeldDraft).toHaveBeenCalledWith(7, {
      tailoredResume: 'Jane', coverLetter: 'Dear Globex team',
    }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('nothing in the documents is flagged'), 'success'))
    // The explanation is fetched again so the cleared flag disappears.
    expect(window.api.getHoldExplanation).toHaveBeenCalledTimes(2)
    expect(dialog().getByText('Approve & submit').closest('button').disabled).toBe(false)
  })
})

describe('Review — stopping a bulk approval', () => {
  it('offers a stop button while several drafts are being sent', async () => {
    render(<Review active showToast={vi.fn()} />)
    fireEvent.click(await screen.findByText(/Select all 2/))
    fireEvent.click(screen.getByText(/Approve & submit \(2\)/))
    window.api.__emit('review:log', '— Approving 1 of 2 —')
    fireEvent.click(await screen.findByText('Stop after this one'))
    expect(window.api.cancelBulkApply).toHaveBeenCalled()
    expect(await screen.findByText(/Stopping after the current submission/)).toBeTruthy()
  })
})

describe('CSV export feedback', () => {
  it('says how many rows were exported', async () => {
    window.api.exportCSV = vi.fn(async () => ({ success: true, count: 12 }))
    const showToast = vi.fn()
    await exportCsv({}, showToast)
    expect(showToast).toHaveBeenCalledWith('Exported 12 applications to CSV', 'success')
  })

  it('reports a file that could not be written', async () => {
    window.api.exportCSV = vi.fn(async () => ({ success: false, error: 'That file is open in another program — close it and export again.' }))
    const showToast = vi.fn()
    await exportCsv({}, showToast)
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('open in another program'), 'error')
  })

  it('stays quiet when the save dialog is cancelled', async () => {
    window.api.exportCSV = vi.fn(async () => ({ canceled: true }))
    const showToast = vi.fn()
    await exportCsv({}, showToast)
    expect(showToast).not.toHaveBeenCalled()
  })
})
