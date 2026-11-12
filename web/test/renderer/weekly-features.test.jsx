import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TaskInbox from '../../src/components/TaskInbox'
import WeeklyGoals from '../../src/components/WeeklyGoals'
import SkillsGap from '../../src/components/SkillsGap'

describe('Thank-you notes, weekly goals and the skills gap', () => {
  it('drafts a thank-you note, warns about the placeholder, and marks it sent', async () => {
    const task = { id: 'thank-you:4', kind: 'thank-you', applicationId: 7, interviewId: 4, title: 'Send a thank-you note', company: 'Acme', jobTitle: 'Engineer', due: '2026-11-13' }
    const placeholder = '[one specific thing you discussed]'
    window.api.getTaskInbox = vi.fn(async () => [task])
    window.api.draftThankYou = vi.fn(async () => ({ success: true, to: 'sam@acme.example', subject: 'Thank you', body: `Hi Sam,\n\nI enjoyed ${placeholder}.`, placeholder }))
    window.api.openMailDraft = vi.fn(async () => ({ success: true }))
    window.api.completeInboxTask = vi.fn(async () => { window.api.getTaskInbox.mockResolvedValue([]); return { success: true } })
    render(<TaskInbox active onOpenApplication={() => {}} />)
    await screen.findByText('Send a thank-you note')
    fireEvent.click(screen.getByText('Draft note'))
    await screen.findByDisplayValue('Thank you')
    expect(window.api.draftThankYou).toHaveBeenCalledWith(4)
    expect(screen.getByText(/Replace \[one specific thing you discussed\]/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Hi Sam,\n\nI enjoyed the architecture chat.' } })
    expect(screen.queryByText(/Replace \[one specific thing/)).toBeNull()
    fireEvent.click(screen.getByText('Open in mail app'))
    await waitFor(() => expect(window.api.openMailDraft).toHaveBeenCalledWith({ to: 'sam@acme.example', subject: 'Thank you', body: 'Hi Sam,\n\nI enjoyed the architecture chat.' }))
    fireEvent.click(screen.getAllByText('Mark sent').pop())
    await screen.findByText('No outstanding tasks.')
    expect(window.api.completeInboxTask).toHaveBeenCalledWith(task)
  })

  it('shows progress against each goal and saves new targets', async () => {
    window.api.getWeeklyGoals = vi.fn(async () => ({
      weekStart: '2026-11-09', weekEnd: '2026-11-15', targets: { applications: 10, followUps: 0, contacts: 2 },
      goals: [
        { key: 'applications', label: 'Applications sent', target: 10, done: 2, state: 'behind' },
        { key: 'contacts', label: 'People contacted', target: 2, done: 2, state: 'done' },
      ],
    }))
    window.api.saveWeeklyGoals = vi.fn(async (t) => ({ success: true, targets: t }))
    render(<WeeklyGoals active />)
    await screen.findByText('Behind pace')
    expect(screen.getByText('Done')).toBeTruthy()
    fireEvent.click(screen.getByText('Edit goals'))
    fireEvent.change(screen.getByLabelText('Follow-ups done'), { target: { value: '3' } })
    fireEvent.click(screen.getByText('Save goals'))
    await waitFor(() => expect(window.api.saveWeeklyGoals).toHaveBeenCalledWith({ applications: 10, followUps: '3', contacts: 2 }))
  })

  it('lists skills the résumé does not name, and says when there is too little data', async () => {
    window.api.getSkillsGap = vi.fn(async ({ days }) => days === 30
      ? { sample: 3, enoughData: false, missing: [], covered: [], hasResume: true }
      : {
        sample: 40, enoughData: true, hasResume: true,
        missing: [{ skill: 'Kubernetes', jobs: 12, share: 0.3, examples: [{ company: 'Acme', job_title: 'SRE' }] }],
        covered: [{ skill: 'React', jobs: 20, share: 0.5, examples: [] }],
      })
    render(<SkillsGap active />)
    await screen.findByText('Kubernetes')
    expect(screen.getByText('12 ads (30%)')).toBeTruthy()
    expect(screen.getByText('React')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Time range for skills'), { target: { value: '30' } })
    await screen.findByText(/too few to call anything a trend/)
  })
})
