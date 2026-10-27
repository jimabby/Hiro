import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import AskHiro from '../../src/pages/AskHiro'
import Offers from '../../src/pages/Offers'
import { AtsBoards } from '../../src/pages/settings/AtsBoards'

describe('Ask Hiro', () => {
  it('lists stored conversations, reopens one and deletes it', async () => {
    let threads = [{ id: 4, title: 'Which are quiet?', message_count: 2 }]
    window.api.askHiroThreads = vi.fn(async () => threads)
    window.api.askHiroThread = vi.fn(async () => ({
      id: 4, title: 'Which are quiet?',
      messages: [{ id: 1, role: 'user', content: 'Which are quiet?' }, { id: 2, role: 'assistant', content: 'Two are quiet.', actions: [] }],
    }))
    window.api.askHiroDeleteThread = vi.fn(async () => { threads = []; return { success: true } })
    render(<AskHiro />)
    fireEvent.click(await screen.findByText('Which are quiet?'))
    expect(await screen.findByText('Two are quiet.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Delete conversation Which are quiet?'))
    await waitFor(() => expect(screen.queryByText('Two are quiet.')).toBeNull())
    expect(window.api.askHiroDeleteThread).toHaveBeenCalledWith(4)
  })

  it('sends the thread id, not the history, and continues the same thread', async () => {
    window.api.askHiroThreads = vi.fn(async () => [])
    window.api.askHiro = vi.fn(async () => ({ success: true, reply: 'Answer', actions: [], threadId: 9 }))
    render(<AskHiro />)
    const box = screen.getByLabelText('Ask Hiro a question')
    fireEvent.change(box, { target: { value: 'First?' } })
    fireEvent.click(screen.getByText('Ask'))
    await screen.findByText('Answer')
    fireEvent.change(box, { target: { value: 'Second?' } })
    fireEvent.click(screen.getByText('Ask'))
    await waitFor(() => expect(window.api.askHiro).toHaveBeenCalledTimes(2))
    expect(window.api.askHiro.mock.calls[0]).toEqual(['First?', null])
    expect(window.api.askHiro.mock.calls[1]).toEqual(['Second?', 9])
  })

  it('sets a follow-up only after the user confirms it, with their edits', async () => {
    window.api.askHiroThreads = vi.fn(async () => [])
    window.api.askHiro = vi.fn(async () => ({
      success: true, reply: 'Acme has gone quiet.', threadId: 1,
      actions: [{ type: 'setFollowUp', id: 7, date: '2026-11-02', note: 'Chase', title: 'Engineer', company: 'Acme' }],
    }))
    window.api.askHiroSetFollowUp = vi.fn(async (_id, date) => ({ success: true, date }))
    const showToast = vi.fn()
    render(<AskHiro showToast={showToast} />)
    fireEvent.change(screen.getByLabelText('Ask Hiro a question'), { target: { value: 'Quiet?' } })
    fireEvent.click(screen.getByText('Ask'))
    fireEvent.click(await screen.findByText('Set follow-up for Engineer at Acme on 2026-11-02'))
    expect(window.api.askHiroSetFollowUp).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Follow-up date'), { target: { value: '2026-11-03' } })
    fireEvent.click(screen.getByText('Confirm follow-up'))
    await waitFor(() => expect(window.api.askHiroSetFollowUp).toHaveBeenCalledWith(7, '2026-11-03', 'Chase'))
    expect(showToast).toHaveBeenCalledWith('Follow-up set for 2026-11-03', 'success')
  })
})

describe('Offers in different currencies', () => {
  const offer = (id, currency, comp, extra = {}) => ({
    applicationId: id, job_title: 'Engineer', company: `Co${id}`, currency, comparableComp: comp, base_salary: comp,
    decision: 'considering', convertedComp: null, convertedRate: null, convertedCurrency: '', ...extra,
  })

  it('saves the user\'s rates and labels converted figures', async () => {
    let data = {
      offers: [offer(1, 'AUD', 180000), offer(2, 'EUR', 100000)], live: 2,
      comparisonNote: 'Choose a currency for each offer.', exchangeRates: { base: '', rates: {} }, converted: null,
    }
    window.api.getOffers = vi.fn(async () => data)
    window.api.getApplications = vi.fn(async () => [])
    window.api.setOfferExchangeRates = vi.fn(async () => {
      data = {
        ...data, comparisonNote: '', exchangeRates: { base: 'AUD', rates: { EUR: 1.65 } },
        offers: [offer(1, 'AUD', 180000, { convertedComp: 180000, convertedRate: 1, convertedCurrency: 'AUD' }),
          offer(2, 'EUR', 100000, { convertedComp: 165000, convertedRate: 1.65, convertedCurrency: 'AUD' })],
        converted: { base: 'AUD', best: 180000, spread: 15000, rates: { EUR: 1.65 } },
      }
      return { success: true }
    })
    render(<Offers />)
    fireEvent.click(await screen.findByText('Set exchange rates'))
    fireEvent.change(screen.getByLabelText('Base currency'), { target: { value: 'aud' } })
    fireEvent.change(screen.getByLabelText('Rate for EUR'), { target: { value: '1.65' } })
    fireEvent.click(screen.getByText('Save rates'))
    await waitFor(() => expect(window.api.setOfferExchangeRates).toHaveBeenCalledWith({ base: 'AUD', rates: { EUR: 1.65 } }))
    expect(await screen.findByText(/converted at your rate, 1 EUR = 1.65 AUD/)).toBeTruthy()
    expect(screen.getByText('best, converted to AUD at your rates')).toBeTruthy()
  })
})

describe('Career board discovery', () => {
  it('offers hits and adds one only when chosen', async () => {
    window.api.discoverAtsBoards = vi.fn(async () => ({
      success: true, companies: 2, probed: 4, stopped: '',
      hits: [{ company: 'Rocket Lab', provider: 'lever', slug: 'rocketlab', count: 4, sample: ['Engineer'], boardName: '' }],
    }))
    const set = vi.fn()
    render(<AtsBoards form={{ atsBoards: [] }} set={set} />)
    fireEvent.click(screen.getByText('Find boards for companies you’ve applied to'))
    expect(await screen.findByText(/4 open roles/)).toBeTruthy()
    expect(set).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Add Rocket Lab board'))
    expect(set).toHaveBeenCalledWith('atsBoards', [expect.objectContaining({ provider: 'lever', slug: 'rocketlab', label: 'Rocket Lab' })])
  })
})
