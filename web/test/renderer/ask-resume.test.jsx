import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, waitFor, within } from '@testing-library/react'
import AskHiro from '../../src/pages/AskHiro'
import { splitDrafts } from '../../src/chatDrafts'

const RESUME = 'Jane Doe\nEXPERIENCE\nData Engineer at Acme'

function pdfFile(name = 'Jane CV.pdf', body = '%PDF-1.4 fake') {
  return new File([body], name, { type: 'application/pdf' })
}

describe('splitDrafts', () => {
  it('separates conversation from the documents the assistant wrote', () => {
    const segs = splitDrafts('Here it is.\n<<<RESUME>>>\nJane\n<<<END>>>\nAnything else?\n<<<COVER_LETTER>>>\nDear Sam')
    expect(segs).toEqual([
      { type: 'text', text: 'Here it is.' },
      { type: 'draft', kind: 'resume', text: 'Jane', index: 0 },
      { type: 'text', text: 'Anything else?' },
      { type: 'draft', kind: 'coverLetter', text: 'Dear Sam', index: 1 },
    ])
  })

  it('leaves a reply with no markers as one block of text', () => {
    expect(splitDrafts('Just advice.')).toEqual([{ type: 'text', text: 'Just advice.' }])
  })
})

describe('Ask Hiro with a résumé', () => {
  it('attaches a file by its bytes and sends it with the question', async () => {
    window.api.askHiroThreads = vi.fn(async () => [])
    window.api.askHiroReadAttachment = vi.fn(async () => ({ success: true, name: 'Jane CV', ext: 'pdf', text: RESUME, words: 6 }))
    window.api.askHiro = vi.fn(async () => ({ success: true, reply: 'Looks solid.', actions: [], threadId: 3 }))
    const showToast = vi.fn()
    render(<AskHiro showToast={showToast} />)

    fireEvent.change(screen.getByTestId('resume-file'), { target: { files: [pdfFile()] } })
    expect(await screen.findByText('Jane CV')).toBeTruthy()
    const [name, bytes] = window.api.askHiroReadAttachment.mock.calls[0]
    expect(name).toBe('Jane CV.pdf')
    expect(bytes).toBeInstanceOf(Uint8Array)

    // Résumé starters replace the empty-state prompt to attach one.
    fireEvent.click(screen.getByText('Review my résumé and list the five changes that would help most.'))
    await screen.findByText('Looks solid.')
    expect(window.api.askHiro).toHaveBeenCalledWith(
      'Review my résumé and list the five changes that would help most.', null,
      { resumeName: 'Jane CV', resumeText: RESUME, jobText: '' }, expect.any(String))
  })

  it('attaches a file dropped on the chat', async () => {
    window.api.askHiroThreads = vi.fn(async () => [])
    window.api.askHiroReadAttachment = vi.fn(async () => ({ success: true, name: 'Dropped', ext: 'docx', text: RESUME, words: 6 }))
    render(<AskHiro />)
    const chat = screen.getByTestId('ask-chat')
    const dataTransfer = { types: ['Files'], files: [pdfFile('Dropped.docx')] }
    fireEvent.dragEnter(chat, { dataTransfer })
    expect(screen.getByText('Drop your résumé to attach it')).toBeTruthy()
    fireEvent.drop(chat, { dataTransfer })
    expect(await screen.findByText('Dropped')).toBeTruthy()
    expect(screen.queryByText('Drop your résumé to attach it')).toBeNull()
  })

  it('says why a file could not be read and attaches nothing', async () => {
    window.api.askHiroThreads = vi.fn(async () => [])
    window.api.askHiroReadAttachment = vi.fn(async () => ({ success: false, error: 'No text could be read from that PDF.' }))
    const showToast = vi.fn()
    render(<AskHiro showToast={showToast} />)
    fireEvent.change(screen.getByTestId('resume-file'), { target: { files: [pdfFile()] } })
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('No text could be read from that PDF.', 'error'))
    expect(screen.queryByLabelText('Attached documents')).toBeNull()
  })

  it('uses a résumé already saved in Settings, with a job ad', async () => {
    window.api.getConfig = vi.fn(async () => ({ resumes: [{ id: 'r1', name: 'Data résumé', text: RESUME }] }))
    window.api.askHiroThreads = vi.fn(async () => [])
    window.api.askHiro = vi.fn(async () => ({ success: true, reply: 'About 70%.', actions: [], threadId: 5 }))
    render(<AskHiro />)
    fireEvent.change(await screen.findByLabelText('Use a saved résumé'), { target: { value: 'r1' } })
    fireEvent.click(screen.getByText('+ Job ad'))
    fireEvent.change(screen.getByLabelText('Job ad'), { target: { value: 'Senior Data Engineer, Spark' } })
    fireEvent.click(screen.getByText('How well does my résumé match this job? Be honest.'))
    await screen.findByText('About 70%.')
    expect(window.api.askHiro.mock.calls[0][2]).toEqual({ resumeName: 'Data résumé', resumeText: RESUME, jobText: 'Senior Data Engineer, Spark' })
  })

  it('shows a drafted résumé as a card that can be saved, with what the check found', async () => {
    window.api.askHiroThreads = vi.fn(async () => [])
    window.api.askHiro = vi.fn(async () => ({
      success: true, threadId: 2,
      reply: 'Rewritten below.\n<<<RESUME>>>\nJane Doe\nPhD, Statistics\n<<<END>>>',
      actions: [{ type: 'draft', kind: 'resume', checked: true, flags: [{ kind: 'credential', value: 'PhD' }] }],
    }))
    window.api.askHiroSaveResume = vi.fn(async () => ({ success: true, id: '9', name: 'Résumé (rewritten)' }))
    window.api.downloadResume = vi.fn(async () => ({ success: true }))
    const showToast = vi.fn()
    render(<AskHiro showToast={showToast} />)
    fireEvent.change(screen.getByLabelText('Ask Hiro a question'), { target: { value: 'Rewrite it' } })
    fireEvent.keyDown(screen.getByLabelText('Ask Hiro a question'), { key: 'Enter' })

    const card = await screen.findByRole('region', { name: 'Résumé draft' })
    expect(within(card).getByText(/PhD, Statistics/)).toBeTruthy()
    expect(within(card).getByRole('note').textContent).toMatch(/qualification “PhD”/)
    expect(screen.getByText('Rewritten below.')).toBeTruthy()
    // The markers are for the app, not the reader.
    expect(screen.queryByText(/<<<RESUME>>>/)).toBeNull()

    fireEvent.click(within(card).getByText('Word'))
    await waitFor(() => expect(window.api.downloadResume).toHaveBeenCalledWith('Jane Doe\nPhD, Statistics', 'Resume', 'docx', 'resume'))
    fireEvent.click(within(card).getByText('Save to my résumés'))
    await waitFor(() => expect(window.api.askHiroSaveResume).toHaveBeenCalledWith({ name: 'Résumé (rewritten)', text: 'Jane Doe\nPhD, Statistics' }))
    expect(await within(card).findByText('✓ Saved')).toBeTruthy()
  })

  it('Shift+Enter is a new line, not a send', () => {
    window.api.askHiroThreads = vi.fn(async () => [])
    window.api.askHiro = vi.fn()
    render(<AskHiro />)
    const box = screen.getByLabelText('Ask Hiro a question')
    fireEvent.change(box, { target: { value: 'line one' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(window.api.askHiro).not.toHaveBeenCalled()
  })

  it('restores the résumé a reopened conversation was about', async () => {
    window.api.askHiroThreads = vi.fn(async () => [{ id: 8, title: 'CV review', has_resume: 1 }])
    window.api.askHiroThread = vi.fn(async () => ({
      id: 8, title: 'CV review', documents: { resumeName: 'Old CV', resumeText: RESUME, jobText: '' },
      messages: [{ id: 1, role: 'user', content: 'Review it' }, { id: 2, role: 'assistant', content: 'Fine.', actions: [] }],
    }))
    window.api.askHiro = vi.fn(async () => ({ success: true, reply: 'More.', actions: [], threadId: 8 }))
    render(<AskHiro />)
    fireEvent.click(await screen.findByText('CV review'))
    expect(await screen.findByText('Old CV')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Ask Hiro a question'), { target: { value: 'And now?' } })
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(window.api.askHiro).toHaveBeenCalledWith('And now?', 8, { resumeName: 'Old CV', resumeText: RESUME, jobText: '' }, expect.any(String)))
  })

  it('shows the reply as it is written, and Stop stops that request', async () => {
    window.api.askHiroThreads = vi.fn(async () => [])
    let finish
    window.api.askHiro = vi.fn(() => new Promise(r => { finish = r }))
    window.api.askHiroStop = vi.fn(async () => ({ success: true }))
    render(<AskHiro />)
    fireEvent.change(screen.getByLabelText('Ask Hiro a question'), { target: { value: 'Write a cover letter' } })
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(window.api.askHiro).toHaveBeenCalled())
    const rid = window.api.askHiro.mock.calls[0][3]

    // An event for some other request is not this reply.
    window.api.__emit('ask:stream', { requestId: 'someone-else', text: 'Not mine' })
    window.api.__emit('ask:stream', { requestId: rid, text: 'Sure.\n<<<COVER_LETTER>>>\nDear Sam,\nI built' })
    const live = await screen.findByTestId('ask-streaming')
    expect(live.textContent).toMatch(/Dear Sam/)
    expect(live.textContent).toMatch(/writing…/)
    expect(screen.queryByText('Not mine')).toBeNull()
    // A half-written suggestion line is not shown.
    window.api.__emit('ask:stream', { requestId: rid, text: 'Done.\nACTIONS: [{"type":"op' })
    await waitFor(() => expect(screen.getByTestId('ask-streaming').textContent).toBe('Done.'))

    fireEvent.click(screen.getByText('Stop'))
    expect(window.api.askHiroStop).toHaveBeenCalledWith(rid)
    finish({ success: true, reply: 'Done.', actions: [], stopped: true, threadId: 3 })
    expect(await screen.findByText('Stopped')).toBeTruthy()
    expect(screen.queryByTestId('ask-streaming')).toBeNull()
    expect(screen.getByText('Send')).toBeTruthy()
  })

  it('reads a job ad from a link', async () => {
    window.api.askHiroThreads = vi.fn(async () => [])
    window.api.askHiroReadJobLink = vi.fn(async () => ({ success: true, text: 'Job title: Data Engineer\n\nBuild pipelines', title: 'Data Engineer', company: 'Globex', words: 40, structured: true }))
    const showToast = vi.fn()
    render(<AskHiro showToast={showToast} />)
    fireEvent.click(screen.getByText('+ Job ad'))
    fireEvent.change(screen.getByLabelText('Job ad link'), { target: { value: 'https://jobs.example.com/1' } })
    fireEvent.click(screen.getByText('Read link'))
    await waitFor(() => expect(screen.getByLabelText('Job ad').value).toMatch(/Build pipelines/))
    expect(window.api.askHiroReadJobLink).toHaveBeenCalledWith('https://jobs.example.com/1')
    expect(showToast).toHaveBeenCalledWith('Read Data Engineer at Globex (40 words)', 'success')
  })

  it('runs the ATS check on the attached file and can ask how to fix what it found', async () => {
    window.api.askHiroThreads = vi.fn(async () => [])
    window.api.askHiroReadAttachment = vi.fn(async () => ({ success: true, name: 'Jane CV', ext: 'pdf', text: RESUME, words: 6 }))
    window.api.askHiroCheckAttachment = vi.fn(async () => ({
      ok: true, extractedChars: 900, extract: 'Jane',
      findings: [{ id: 'columns', severity: 'warning', title: 'Two columns', detail: 'Lines interleave.', fix: 'Use one column.' }],
    }))
    window.api.askHiro = vi.fn(async () => ({ success: true, reply: 'Move to one column.', actions: [], threadId: 1 }))
    render(<AskHiro />)
    fireEvent.change(screen.getByTestId('resume-file'), { target: { files: [pdfFile()] } })
    fireEvent.click(await screen.findByText('ATS check'))
    fireEvent.click(screen.getByText('Check ATS readability'))
    expect(await screen.findByText(/Two columns/)).toBeTruthy()
    const [name, bytes] = window.api.askHiroCheckAttachment.mock.calls[0]
    expect([name, bytes instanceof Uint8Array]).toEqual(['Jane CV.pdf', true])
    fireEvent.click(screen.getByText('Ask Hiro how to fix these'))
    await screen.findByText('Move to one column.')
    expect(window.api.askHiro.mock.calls[0][0]).toMatch(/- Two columns: Lines interleave\./)
  })

  it('cannot run the ATS check on a résumé that is only text', async () => {
    window.api.askHiroThreads = vi.fn(async () => [])
    window.api.askHiroReadAttachment = vi.fn(async () => ({ success: true, name: 'notes', ext: 'txt', text: RESUME, words: 6 }))
    render(<AskHiro />)
    fireEvent.change(screen.getByTestId('resume-file'), { target: { files: [pdfFile('notes.txt')] } })
    expect((await screen.findByText('ATS check')).disabled).toBe(true)
  })

  it('offers to try a failed question again', async () => {
    window.api.askHiroThreads = vi.fn(async () => [])
    window.api.askHiro = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'The provider timed out.', threadId: 4 })
      .mockResolvedValueOnce({ success: true, reply: 'Second time lucky.', actions: [], threadId: 4 })
    render(<AskHiro />)
    fireEvent.change(screen.getByLabelText('Ask Hiro a question'), { target: { value: 'Help' } })
    fireEvent.click(screen.getByText('Send'))
    fireEvent.click(await screen.findByText('Try again'))
    expect(await screen.findByText('Second time lucky.')).toBeTruthy()
    expect(screen.queryByText('The provider timed out.')).toBeNull()
    expect(window.api.askHiro.mock.calls[1].slice(0, 2)).toEqual(['Help', 4])
    expect(window.api.askHiro.mock.calls[1][3]).not.toBe(window.api.askHiro.mock.calls[0][3])
  })
})
