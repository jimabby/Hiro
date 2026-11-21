import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import SafeAnswer from '../../src/components/SafeAnswer'
import Practice, { formatInterval } from '../../src/pages/Practice'

const card = (over = {}) => ({
  id: 'node-001', deck: 'bank', format: 'html', topic: 'Node.js', question: 'What is Node.js?',
  answer: '<p>A <b>runtime</b>.</p>', difficulty: 'easy', tags: [], versions: [], state: null, flag: null,
  intervals: { again: 1, hard: 1, good: 1, easy: 1 }, done: false, ...over,
})

function dayWith(cards) {
  return {
    day: '2026-11-21', settings: { topics: [], dailyCount: 8 }, topics: [{ name: 'Node.js', count: 20 }],
    cards, queue: cards.filter(c => !c.done).map(c => c.id), doneCount: cards.filter(c => c.done).length, dueLater: 0, available: 10,
  }
}

const stats = { streak: 2, daysThisWeek: 3, weeklyGoalDays: 4, practisedToday: true, due: 1, learned: 0, seen: 3, total: 171, flagged: 0 }

describe('SafeAnswer', () => {
  it('keeps the allowed formatting', () => {
    const { container } = render(<SafeAnswer answer={'<p>Use <code>===</code></p><ul><li><b>a</b></li></ul><pre><code>x &lt; 1</code></pre>'} />)
    expect(container.querySelector('p code').textContent).toBe('===')
    expect(container.querySelector('ul li b').textContent).toBe('a')
    expect(container.querySelector('pre code').textContent).toBe('x < 1')
  })

  it('drops scripts, handlers, links and attributes', () => {
    const evil = '<p onclick="alert(1)" style="color:red">Hi<script>window.pwned=1</script><img src=x onerror="window.pwned=1"><a href="javascript:alert(1)">link</a></p><iframe src="https://evil.example"></iframe>'
    const { container } = render(<SafeAnswer answer={evil} />)
    const p = container.querySelector('p')
    expect(p.getAttribute('onclick')).toBeNull()
    expect(p.getAttribute('style')).toBeNull()
    expect(container.querySelector('script, img, a, iframe')).toBeNull()
    expect(p.textContent).toBe('Hilink')
    expect(window.pwned).toBeUndefined()
  })

  it('shows job answers as plain paragraphs, not HTML', () => {
    const { container } = render(<SafeAnswer format="text" answer={'First <b>para</b>\n\nSecond'} />)
    const paras = container.querySelectorAll('p')
    expect(paras.length).toBe(2)
    expect(paras[0].textContent).toBe('First <b>para</b>')
    expect(container.querySelector('b')).toBeNull()
  })
})

describe('Practice page', () => {
  it('formats intervals', () => {
    expect([formatInterval(1), formatInterval(45), formatInterval(365)]).toEqual(['1d', '2mo', '1y'])
  })

  it('reveals the answer, rates the card, and moves on', async () => {
    let today = dayWith([card(), card({ id: 'node-002', question: 'What is a Buffer?' })])
    window.api.getPracticeToday = vi.fn(async () => today)
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.ratePracticeCard = vi.fn(async (id) => {
      today = dayWith(today.cards.map(c => c.id === id ? { ...c, done: true } : c))
      return { success: true }
    })
    render(<Practice active showToast={() => {}} />)
    expect(await screen.findByText('What is Node.js?')).toBeTruthy()
    expect(screen.getByText('3 of 4 days')).toBeTruthy()
    expect(screen.queryByText('runtime')).toBeNull()
    fireEvent.click(screen.getByText(/Show answer/))
    expect(screen.getByText('runtime')).toBeTruthy()
    fireEvent.click(screen.getByText('Good'))
    await waitFor(() => expect(window.api.ratePracticeCard).toHaveBeenCalledWith('node-001', 'good'))
    expect(await screen.findByText('What is a Buffer?')).toBeTruthy()
    expect(screen.getByText('Card 2 of 2')).toBeTruthy()
  })

  it('uses Space to reveal and digits to rate, marking the keys handled', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.ratePracticeCard = vi.fn(async () => ({ success: true }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.keyDown(window, { key: ' ' })
    expect(screen.getByText('runtime')).toBeTruthy()
    const handled = fireEvent.keyDown(window, { key: '1' }) === false
    expect(handled).toBe(true)
    await waitFor(() => expect(window.api.ratePracticeCard).toHaveBeenCalledWith('node-001', 'again'))
  })

  it('leaves digits alone before the answer is shown', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.ratePracticeCard = vi.fn()
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    expect(fireEvent.keyDown(window, { key: '2' })).toBe(true)
    expect(window.api.ratePracticeCard).not.toHaveBeenCalled()
  })

  it('reports a card with a reason and note', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.flagPracticeCard = vi.fn(async () => ({ success: true }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByText('Report outdated or wrong'))
    fireEvent.click(screen.getByLabelText('Wrong'))
    fireEvent.change(screen.getByLabelText('Report note'), { target: { value: 'Mentions Node 12' } })
    fireEvent.click(screen.getByText('Report'))
    await waitFor(() => expect(window.api.flagPracticeCard).toHaveBeenCalledWith('node-001', 'wrong', 'Mentions Node 12'))
  })

  it('offers more cards when the day is done', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card({ done: true })]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.practiceMore = vi.fn(async () => dayWith([card({ done: true }), card({ id: 'node-003', question: 'What is npm?' })]))
    render(<Practice active showToast={() => {}} />)
    expect(await screen.findByText('Done for today')).toBeTruthy()
    fireEvent.click(screen.getByText('Practise 8 more'))
    expect(await screen.findByText('What is npm?')).toBeTruthy()
  })

  it('searches the bank in Browse', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeBank = vi.fn(async () => ({
      day: '2026-11-21', topics: [{ name: 'Node.js', count: 2 }], settings: { topics: [], dailyCount: 8 }, orphanFlags: [],
      cards: [card(), card({ id: 'node-002', question: 'What is a Buffer?', answer: '<p>Raw bytes</p>' })],
    }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('tab', { name: 'Browse' }))
    await screen.findByText('2 of 2 questions')
    fireEvent.change(screen.getByLabelText('Search questions'), { target: { value: 'bytes' } })
    expect(screen.getByText('1 of 2 questions')).toBeTruthy()
    expect(screen.getByText('What is a Buffer?')).toBeTruthy()
  })
})
