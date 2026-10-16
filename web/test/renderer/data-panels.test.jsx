import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import { DataTransferCard } from '../../src/pages/settings/DataPanels'

// Settings -> Data: an import is previewed (a dry run that changes nothing)
// before it can be confirmed, and the scheduled export is configured in place.

const schedule = {
  success: true, enabled: false, folder: '', frequency: 'weekly', keep: 5,
  hasPassphrase: false, lastRunAt: null, lastResult: null, nextDueAt: null, files: [],
}

beforeEach(() => {
  window.api.getScheduledExport = vi.fn(async () => schedule)
  window.api.exportDataPreview = vi.fn(async () => ({ success: true, counts: {} }))
})

describe('Data import preview', () => {
  it('shows what an import would add, skip and ignore before it can be confirmed', async () => {
    window.api.chooseDataImport = vi.fn(async () => ({ success: true, encrypted: false, counts: { applications: 2 } }))
    window.api.previewDataImport = vi.fn(async () => ({
      success: true, dryRun: true, total: 3,
      added: { applications: 1, status_history: 2 }, skipped: { applications: 1 },
      unknownColumns: { applications: ['from_the_future'] },
    }))
    window.api.importData = vi.fn(async () => ({ success: true, total: 3, added: { applications: 1 } }))
    render(<DataTransferCard showToast={() => {}} />)
    fireEvent.click(await screen.findByText('Import'))
    fireEvent.click(screen.getByText('Choose a file'))
    const preview = await screen.findByTestId('import-preview')
    expect(preview.textContent).toContain('Would add 3 rows')
    expect(preview.textContent).toContain('1 applications · 2 status history')
    expect(preview.textContent).toContain('Skip (already here): 1 applications')
    expect(preview.textContent).toContain('applications (from_the_future)')
    expect(window.api.importData).not.toHaveBeenCalled()
    const confirm = screen.getAllByText('Import').find(el => el.className.includes('btn-primary'))
    fireEvent.click(confirm)
    await waitFor(() => expect(window.api.importData).toHaveBeenCalledTimes(1))
  })

  it('keeps an encrypted import unconfirmable until it has been previewed', async () => {
    window.api.chooseDataImport = vi.fn(async () => ({ success: true, encrypted: true, counts: {} }))
    window.api.previewDataImport = vi.fn(async () => ({ success: true, total: 0, added: {}, skipped: { applications: 4 } }))
    render(<DataTransferCard showToast={() => {}} />)
    fireEvent.click(await screen.findByText('Import'))
    fireEvent.click(screen.getByText('Choose a file'))
    // Two fields are labelled Passphrase on this card; this is the import's.
    await waitFor(() => expect(document.getElementById('set-f3')).toBeTruthy())
    fireEvent.change(document.getElementById('set-f3'), { target: { value: 'secret phrase' } })
    const confirm = screen.getAllByText('Import').find(el => el.className.includes('btn-primary'))
    expect(confirm.disabled).toBe(true)
    fireEvent.click(screen.getByText('Preview'))
    expect((await screen.findByTestId('import-preview')).textContent).toContain('Nothing new to add')
    expect(window.api.previewDataImport).toHaveBeenCalledWith('secret phrase')
    expect(confirm.disabled).toBe(false)
  })
})

describe('Scheduled export', () => {
  it('saves a folder, frequency, retention and passphrase', async () => {
    window.api.chooseScheduledExportFolder = vi.fn(async () => ({ success: true, folder: 'D:\\Backups\\Hiro' }))
    window.api.configureScheduledExport = vi.fn(async (s) => ({ ...schedule, ...s, success: true, hasPassphrase: true }))
    render(<DataTransferCard showToast={() => {}} />)
    fireEvent.click(await screen.findByLabelText('Export automatically'))
    fireEvent.click(screen.getByText('Choose…'))
    await waitFor(() => expect(screen.getByLabelText('Folder').value).toBe('D:\\Backups\\Hiro'))
    fireEvent.change(screen.getByLabelText('How often'), { target: { value: 'daily' } })
    fireEvent.change(screen.getByLabelText('Keep'), { target: { value: '3' } })
    fireEvent.change(document.getElementById('sched-export-pass'), { target: { value: 'long passphrase' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(window.api.configureScheduledExport).toHaveBeenCalledWith({
      enabled: true, folder: 'D:\\Backups\\Hiro', frequency: 'daily', keep: '3', passphrase: 'long passphrase',
    }))
  })

  it('reports a failed run instead of a stale success', async () => {
    window.api.getScheduledExport = vi.fn(async () => ({
      ...schedule, enabled: true, folder: 'D:\\x', hasPassphrase: true,
      lastRunAt: '2026-10-01T00:00:00Z', lastResult: { success: false, reason: 'That folder does not exist.' },
    }))
    render(<DataTransferCard showToast={() => {}} />)
    expect(await screen.findByText(/Last attempt failed: That folder does not exist\./)).toBeTruthy()
  })
})
