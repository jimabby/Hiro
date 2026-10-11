import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import ApplicationChecklist from '../../src/components/ApplicationChecklist'
import SavedViews from '../../src/components/SavedViews'
import SyncHealth from '../../src/components/SyncHealth'

describe('Application organisation', () => {
  it('adds a dated task, completes it, and deletes it', async () => {
    let rows = []
    window.api.getChecklist = vi.fn(async () => rows)
    window.api.updateChecklist = vi.fn(async (_, change) => {
      if (change.remove) rows = []
      else if (change.id) rows = rows.map(r => ({ ...r, ...change }))
      else rows = [{ ...change, id: 'task', done: false }]
      return rows
    })
    render(<ApplicationChecklist applicationId={7} />)
    fireEvent.change(screen.getByLabelText('Checklist task'), { target: { value: 'Prepare portfolio' } })
    fireEvent.change(screen.getByLabelText('Task due date'), { target: { value: '2026-11-03' } })
    fireEvent.click(screen.getByText('Add task'))
    expect(await screen.findByLabelText('Prepare portfolio')).toBeTruthy()
    expect(window.api.updateChecklist).toHaveBeenCalledWith(7, { id: null, title: 'Prepare portfolio', due: '2026-11-03' })
    fireEvent.click(screen.getByLabelText('Prepare portfolio'))
    await screen.findByText(/1\/1 complete/)
    fireEvent.click(screen.getByLabelText('Delete Prepare portfolio'))
    await screen.findByText(/0\/0 complete/)
  })
  it('restores filters and sort together from a saved view', async () => {
    const view = { id: 'interviews', name: 'Interviews to chase', filter: { status: 'interview', dueOnly: true, minMatch: '80' }, sort: { key: 'match_score', dir: 'desc' } }
    window.api.getSavedViews = vi.fn(async () => [view])
    const apply = vi.fn()
    render(<SavedViews filter={{}} sort={{}} onApply={apply} />)
    await screen.findByText(view.name)
    fireEvent.change(screen.getByLabelText('Saved application view'), { target: { value: view.id } })
    expect(apply).toHaveBeenCalledWith(view)
  })
  it('shows failed items and retries without claiming an error was successful', async () => {
    const status = { error: 'Offline', pendingChanges: [{ id: 1, title: 'Engineer', company: 'Acme' }], failedItems: [{ id: 1, title: 'Engineer', error: 'Offline' }], stage: 'Upload applications' }
    window.api.cloudStatus = vi.fn(async () => status)
    window.api.cloudSyncNow = vi.fn(async () => ({ success: false, error: 'Still offline', status }))
    render(<SyncHealth />)
    await screen.findByText('Needs attention')
    expect(screen.getByText('Engineer: Offline')).toBeTruthy()
    fireEvent.click(screen.getByText('Sync / retry pending changes'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Still offline'))
  })
})
