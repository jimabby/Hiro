import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TaskInbox from '../../src/components/TaskInbox'
import CloudCommands from '../../src/components/CloudCommands'

describe('Task inbox and command history', () => {
  it('opens an application and completes its checklist task', async () => {
    const task = { id: 'task', kind: 'checklist', applicationId: 7, taskId: 't', title: 'Portfolio', company: 'Acme', due: '2026-10-20' }
    window.api.getTaskInbox = vi.fn(async () => [task])
    window.api.completeInboxTask = vi.fn(async () => { window.api.getTaskInbox.mockResolvedValue([]); return { success: true } })
    const open = vi.fn()
    render(<TaskInbox active onOpenApplication={open} />)
    await screen.findByText('Portfolio')
    fireEvent.click(screen.getByText('Open application'))
    expect(open).toHaveBeenCalledWith(7)
    fireEvent.click(screen.getByText('Mark done'))
    await screen.findByText('No outstanding tasks.')
    expect(window.api.completeInboxTask).toHaveBeenCalledWith(task)
  })
  it('shows failure reasons and retries failed scans', async () => {
    window.api.getCloudCommands = vi.fn(async () => [{ id: 'one', kind: 'scan', keywords: 'Engineer', status: 'failed', error: 'Desktop interrupted', created_at: '2026-10-17T00:00:00Z' }])
    window.api.retryCloudCommand = vi.fn(async () => ({ success: true }))
    render(<CloudCommands />)
    await screen.findByText('Desktop interrupted')
    fireEvent.click(screen.getByText('Retry command'))
    await waitFor(() => expect(window.api.retryCloudCommand).toHaveBeenCalledWith('scan', 'one'))
  })
})
