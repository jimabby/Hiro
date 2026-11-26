import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import SafeAnswer from '../../src/components/SafeAnswer'
import Practice, { formatInterval, ratingWhen, PracticeCalendar, calendarShade } from '../../src/pages/Practice'
import Setup from '../../src/pages/Setup'
import App from '../../src/App'

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
    // A missed card returns at the end of today's cards, not tomorrow.
    expect(['again', 'hard', 'easy'].map(k => ratingWhen(k, { again: 1, hard: 3, good: 6, easy: 8 }))).toEqual(['today', '3d', '8d'])
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
    expect((await screen.findByLabelText('Practice progress')).textContent).toContain('3/4 days this week')
    expect(screen.queryByText('runtime')).toBeNull()
    fireEvent.click(screen.getByText(/Show answer/))
    expect(await screen.findByText('runtime')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Good/ }))
    await waitFor(() => expect(window.api.ratePracticeCard).toHaveBeenCalledWith('node-001', 'good'))
    expect(await screen.findByText('What is a Buffer?')).toBeTruthy()
    expect(await screen.findByText('Card 2 of 2')).toBeTruthy()
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

  it('ignores a second key press while the next card is loading', async () => {
    let today = dayWith([card(), card({ id: 'node-002', question: 'What is a Buffer?' })])
    // After a rating, the next load waits until the test lets it finish.
    let finishLoad = null
    let slow = false
    window.api.getPracticeToday = vi.fn(() => (slow ? new Promise(r => { finishLoad = () => r(today) }) : Promise.resolve(today)))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.ratePracticeCard = vi.fn(async (id) => {
      today = dayWith(today.cards.map(c => c.id === id ? { ...c, done: true } : c))
      slow = true
      return { success: true }
    })
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.keyDown(window, { key: ' ' })
    fireEvent.keyDown(window, { key: '3' })
    await waitFor(() => expect(window.api.ratePracticeCard).toHaveBeenCalledTimes(1))
    // The reload is still pending: the rated card is on screen and revealed.
    fireEvent.keyDown(window, { key: '3' })
    expect(window.api.ratePracticeCard).toHaveBeenCalledTimes(1)
    slow = false
    await waitFor(() => expect(finishLoad).toBeTypeOf('function'))
    finishLoad()
    expect(await screen.findByText('What is a Buffer?')).toBeTruthy()
  })

  it('shows a missed card again as a second look, not one more card', async () => {
    const missed = card({ done: true, relearn: true, intervals: { again: 1, hard: 1, good: 1, easy: 1 } })
    window.api.getPracticeToday = vi.fn(async () => ({ ...dayWith([missed, card({ id: 'node-002', done: true })]), queue: ['node-001'], relearnCount: 1 }))
    window.api.getPracticeStats = vi.fn(async () => stats)
    render(<Practice active showToast={() => {}} />)
    expect(await screen.findByText('Once more · 1 to go')).toBeTruthy()
    expect(screen.getByText(/You missed this one earlier/)).toBeTruthy()
    expect(screen.queryByText(/Card 3 of 2/)).toBeNull()
  })

  it('does not rate before the answer is shown, nor let an early digit switch pages', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.ratePracticeCard = vi.fn()
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    // Marked handled (false), so the app-wide 1–9 page shortcuts leave it alone.
    expect(fireEvent.keyDown(window, { key: '2' })).toBe(false)
    expect(window.api.ratePracticeCard).not.toHaveBeenCalled()
    expect(screen.queryByText('runtime')).toBeNull()
  })

  it('reveals with Space even while a button outside the card has focus', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.cramPractice = vi.fn(async (topic) => ({ success: true, topic, total: 2, cards: [card({ id: 'node-010', question: 'What is libuv?' })] }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('tab', { name: 'Cram' }))
    const start = await screen.findByRole('button', { name: 'Start' })
    fireEvent.click(start)
    expect(await screen.findByText('What is libuv?')).toBeTruthy()
    // Start (now "Start again") keeps focus after the click. Space must show
    // the answer, not press it and restart the session.
    const again = screen.getByRole('button', { name: 'Start again' })
    again.focus()
    expect(fireEvent.keyDown(window, { key: ' ' })).toBe(false)
    expect(await screen.findByText('runtime')).toBeTruthy()
    expect(window.api.cramPractice).toHaveBeenCalledTimes(1)
  })

  it('leaves Space to a button on the card itself', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    screen.getByRole('button', { name: /Show answer/ }).focus()
    expect(fireEvent.keyDown(window, { key: ' ' })).toBe(true)
  })

  it('reports a card with a reason and note', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.flagPracticeCard = vi.fn(async () => ({ success: true }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('button', { name: '⚑ Report' }))
    fireEvent.click(screen.getByLabelText('Wrong'))
    fireEvent.change(screen.getByLabelText('Report note'), { target: { value: 'Mentions Node 12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Report' }))
    await waitFor(() => expect(window.api.flagPracticeCard).toHaveBeenCalledWith('node-001', 'wrong', 'Mentions Node 12'))
  })

  it('labels the category beside the topic', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card({ category: 'Comparison' })]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    expect(screen.getByTitle('Category').textContent).toContain('Comparison')
    expect(screen.getByTitle('Topic').textContent).toBe('Node.js')
  })

  it('saves a note on a card and shows it', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.savePracticeNote = vi.fn(async (_, note) => ({ success: true, note: note.trim() }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('button', { name: '✎ Add note' }))
    fireEvent.change(screen.getByLabelText('Your note'), { target: { value: 'Mention the booking API ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))
    await waitFor(() => expect(window.api.savePracticeNote).toHaveBeenCalledWith('node-001', 'Mention the booking API '))
    expect(await screen.findByText('Mention the booking API')).toBeTruthy()
    expect(screen.getByRole('button', { name: '✎ Edit note' })).toBeTruthy()
  })

  it('typing a note does not rate the card', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.ratePracticeCard = vi.fn()
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.keyDown(window, { key: ' ' })
    fireEvent.click(screen.getByRole('button', { name: '✎ Add note' }))
    const box = screen.getByLabelText('Your note')
    box.focus()
    fireEvent.keyDown(box, { key: '1' })
    expect(window.api.ratePracticeCard).not.toHaveBeenCalled()
  })

  it('asks the AI about a card, then a follow-up', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeExplanations = vi.fn(async () => [])
    let n = 0
    window.api.explainPracticeCard = vi.fn(async (_, followUp) => ({
      success: true,
      entry: { id: ++n, prompt: followUp, blocks: followUp ? [{ type: 'p', spans: [{ text: 'Here is a C# example.' }] }] : [{ type: 'p', spans: [{ text: 'It runs JavaScript ' }, { text: 'outside', bold: true }, { text: ' the browser.' }] }] },
    }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('button', { name: /Ask AI/ }))
    await waitFor(() => expect(window.api.explainPracticeCard).toHaveBeenCalledWith('node-001', ''))
    expect(await screen.findByText('outside')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Ask a follow-up question'), { target: { value: 'Show me C#' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(await screen.findByText('Here is a C# example.')).toBeTruthy()
    expect(window.api.explainPracticeCard).toHaveBeenLastCalledWith('node-001', 'Show me C#')
  })

  it('shows saved AI answers without asking again', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card({ explained: true })]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeExplanations = vi.fn(async () => [{ id: 1, prompt: '', blocks: [{ type: 'p', spans: [{ text: 'Saved earlier.' }] }] }])
    window.api.explainPracticeCard = vi.fn()
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('button', { name: /Ask AI · saved/ }))
    expect(await screen.findByText('Saved earlier.')).toBeTruthy()
    expect(window.api.explainPracticeCard).not.toHaveBeenCalled()
  })

  it('generates a deck from a pasted job ad and practises it', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeDecks = vi.fn(async () => ({ generated: [], applications: [], sizes: [10, 15, 20] }))
    window.api.generatePracticeDeck = vi.fn(async () => ({ success: true, deck: { id: 3, title: 'Acme', cards: 15, topic: 'Deck: Acme' } }))
    window.api.savePracticeSettings = vi.fn(async (s) => ({ success: true, settings: s }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('tab', { name: 'Decks' }))
    await screen.findByText('Practise for a specific job')
    const ad = 'We are hiring a junior React developer to build features with React, TypeScript and REST APIs, and to write tests.'
    fireEvent.change(screen.getByLabelText('Deck name (optional)'), { target: { value: 'Acme' } })
    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: ad } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate questions' }))
    await waitFor(() => expect(window.api.generatePracticeDeck).toHaveBeenCalledWith({ title: 'Acme', jobText: ad, count: 15 }))
    fireEvent.click(await screen.findByRole('button', { name: 'Practise this deck now' }))
    await waitFor(() => expect(window.api.savePracticeSettings).toHaveBeenCalledWith({ topics: ['Deck: Acme'], dailyCount: 8 }))
    expect(await screen.findByRole('tab', { name: 'Today', selected: true })).toBeTruthy()
  })

  it('reads an uploaded job ad file into the form', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeDecks = vi.fn(async () => ({ generated: [], applications: [], sizes: [10, 15, 20] }))
    window.api.askHiroReadAttachment = vi.fn(async () => ({ success: true, text: 'Senior Java role. Spring Boot, Kafka.', words: 6 }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('tab', { name: 'Decks' }))
    await screen.findByText('Practise for a specific job')
    const file = new File(['Senior Java role'], 'acme-java.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Upload a job description file'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByLabelText('Job description').value).toBe('Senior Java role. Spring Boot, Kafka.'))
    expect(screen.getByLabelText('Deck name (optional)').value).toBe('acme-java')
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

  it('exports the questions Browse is showing, in the chosen format', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeBank = vi.fn(async () => ({
      day: '2026-11-21', topics: [{ name: 'Node.js', count: 2 }], settings: { topics: [], dailyCount: 8 }, orphanFlags: [],
      cards: [card(), card({ id: 'node-002', question: 'What is a Buffer?', answer: '<p>Raw bytes</p>' })],
    }))
    window.api.exportPracticeCards = vi.fn(async (ids) => ({ success: true, count: ids.length }))
    const showToast = vi.fn()
    render(<Practice active showToast={showToast} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('tab', { name: 'Browse' }))
    await screen.findByText('2 of 2 questions')
    fireEvent.change(screen.getByLabelText('Search questions'), { target: { value: 'bytes' } })
    fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'anki' } })
    fireEvent.click(screen.getByRole('button', { name: 'Export 1 question' }))
    await waitFor(() => expect(window.api.exportPracticeCards).toHaveBeenCalledWith(['node-002'], 'anki'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Exported 1 question', 'success'))
  })

  it('crams a topic: a miss comes round again, and nothing is rated', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.ratePracticeCard = vi.fn()
    window.api.cramPractice = vi.fn(async (topic) => ({
      success: true, topic, total: 30,
      cards: [card({ id: 'node-010', question: 'What is libuv?' }), card({ id: 'node-011', question: 'What is a stream?' })],
    }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('tab', { name: 'Cram' }))
    fireEvent.change(await screen.findByLabelText('Cards in the session'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(window.api.cramPractice).toHaveBeenCalledWith('Node.js', 10))
    expect(await screen.findByText('What is libuv?')).toBeTruthy()
    fireEvent.keyDown(window, { key: ' ' })
    fireEvent.click(await screen.findByRole('button', { name: /Missed it/ }))
    expect(await screen.findByText('What is a stream?')).toBeTruthy()
    fireEvent.keyDown(window, { key: ' ' })
    fireEvent.keyDown(window, { key: '2' })
    // The missed card is back, at the end of the session.
    expect(await screen.findByText('What is libuv?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show answer (Space)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(await screen.findByText('Session done')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('1 of 2 first time · 1 needed another look')
    expect(window.api.ratePracticeCard).not.toHaveBeenCalled()
  })

  it('opens Cram on a weak topic from Insights', async () => {
    window.api.getPracticeToday = vi.fn(async () => ({ ...dayWith([card()]), topics: [{ name: 'Node.js', count: 20 }, { name: 'SQL', count: 12 }] }))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeInsights = vi.fn(async () => ({
      days: 90, totals: { reviews: 20, again: 7, againRate: 0.35, activeDays: 4 }, skillsGap: { available: false, sample: 0 },
      topics: [{ name: 'SQL', reviews: 6, again: 4, hard: 1, cards: 5, againRate: 0.67, demand: null }], weakCards: [],
    }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('tab', { name: 'Insights' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cram' }))
    expect((await screen.findByLabelText('Topic to cram')).value).toBe('SQL')
  })

  it('counts down to an interview and creates questions for one that has none', async () => {
    const day = { ...dayWith([card({ deck: 'job', topic: 'Northwind — Junior Backend Developer', applicationId: 7 })]), countdown: [
      { applicationId: 7, company: 'Northwind', jobTitle: 'Junior Backend Developer', daysLeft: 3, cards: 4, cardsLeft: 3 },
      { applicationId: 9, company: 'Contoso', jobTitle: 'Graduate .NET Developer', daysLeft: 1, cards: 0, cardsLeft: 0 },
    ] }
    window.api.getPracticeToday = vi.fn(async () => day)
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.preparePracticeJobDeck = vi.fn(async () => ({ success: true, cards: 8 }))
    render(<Practice active showToast={() => {}} />)
    expect(await screen.findByText('Northwind interview in 3 days')).toBeTruthy()
    expect(screen.getByText(/3 of 4 cards left today/)).toBeTruthy()
    expect(screen.getByText('Contoso interview tomorrow')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create interview questions' }))
    await waitFor(() => expect(window.api.preparePracticeJobDeck).toHaveBeenCalledWith(9))
    await waitFor(() => expect(window.api.getPracticeToday).toHaveBeenCalledTimes(2))
  })

  it('sets a daily reminder', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeReminder = vi.fn(async () => ({ enabled: false, time: '19:00' }))
    window.api.savePracticeReminder = vi.fn(async (settings) => ({ success: true, settings }))
    render(<Practice active showToast={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /Reminder: off/ }))
    fireEvent.click(screen.getByLabelText('Remind me to practise each day'))
    fireEvent.change(screen.getByLabelText('Reminder time'), { target: { value: '07:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(window.api.savePracticeReminder).toHaveBeenCalledWith({ enabled: true, time: '07:30' }))
    expect(await screen.findByRole('button', { name: /Reminder: 07:30/ })).toBeTruthy()
  })

  it('writes a STAR story from a behavioural question and attaches it', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card({ id: 'behavioural-001', topic: 'Behavioural', category: 'Behavioural', question: 'Tell me about a conflict.' })]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    let saved = []
    window.api.getPracticeStories = vi.fn(async () => saved)
    window.api.savePracticeStory = vi.fn(async (story) => { const created = { ...story, id: 5 }; saved = [created]; return { success: true, story: created } })
    render(<Practice active showToast={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: '★ Add a STAR story' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Write a new story' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Capstone demo' } })
    fireEvent.change(screen.getByLabelText('Situation'), { target: { value: 'Final-year project' } })
    fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'Demo on time' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save story' }))
    await waitFor(() => expect(window.api.savePracticeStory).toHaveBeenCalledWith(expect.objectContaining({ title: 'Capstone demo', situation: 'Final-year project', result: 'Demo on time', cardId: 'behavioural-001' })))
    expect(await screen.findByText('Capstone demo')).toBeTruthy()
  })

  it('attaches an existing story to a question', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card({ id: 'behavioural-002', topic: 'Behavioural', category: 'Behavioural' })]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeStories = vi.fn(async () => [{ id: 3, title: 'Legacy rewrite', situation: 'Old PHP app', task: '', action: '', result: '' }])
    window.api.linkPracticeStory = vi.fn(async () => ({ success: true }))
    render(<Practice active showToast={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: '★ Add a STAR story' }))
    fireEvent.change(await screen.findByLabelText('Attach a story'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    await waitFor(() => expect(window.api.linkPracticeStory).toHaveBeenCalledWith('behavioural-002', 3))
    expect(await screen.findByText('Legacy rewrite')).toBeTruthy()
  })

  it('shows weak topics beside what employers ask for', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeInsights = vi.fn(async () => ({
      days: 90, totals: { reviews: 20, again: 7, againRate: 0.35, activeDays: 4 }, skillsGap: { available: true, sample: 40 },
      topics: [{ name: 'Node.js', reviews: 6, again: 4, hard: 1, cards: 5, againRate: 0.67, demand: { skill: 'Node.js', share: 0.42, jobs: 17, inResume: false } }],
      weakCards: [{ id: 'node-003', question: 'What is the event loop?', topic: 'Node.js', topicKey: 'Node.js', deck: 'bank', lapses: 3 }],
    }))
    window.api.savePracticeSettings = vi.fn(async (settings) => ({ success: true, settings }))
    const onNavigate = vi.fn()
    render(<Practice active showToast={() => {}} onNavigate={onNavigate} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('tab', { name: 'Insights' }))
    expect(await screen.findByText('67%')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toContain('asked for in 42% of recent ads')
    expect(screen.getByText('What is the event loop?', { exact: false })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open the skills report' }))
    expect(onNavigate).toHaveBeenCalledWith('analytics')
    fireEvent.click(screen.getByRole('button', { name: 'Practise' }))
    await waitFor(() => expect(window.api.savePracticeSettings).toHaveBeenCalledWith({ topics: ['Node.js'], dailyCount: 8 }))
  })

  it('offers practice on the first Setup step', () => {
    const onPracticeOnly = vi.fn()
    render(<Setup onComplete={() => {}} onPracticeOnly={onPracticeOnly} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start practising' }))
    expect(onPracticeOnly).toHaveBeenCalled()
  })

  it('lets someone practise before finishing setup, and remembers it', async () => {
    localStorage.removeItem('hiro.practiceOnly')
    window.api.getConfig = vi.fn(async () => ({ setupComplete: false }))
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    const first = render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start practising' }))
    expect(await screen.findByText('What is Node.js?')).toBeTruthy()
    expect(screen.getByText('Interview practice')).toBeTruthy()
    expect(localStorage.getItem('hiro.practiceOnly')).toBe('1')
    first.unmount()
    render(<App />)
    expect(await screen.findByText('What is Node.js?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set up the job search' }))
    expect(await screen.findByText(/Setup Wizard/)).toBeTruthy()
    expect(localStorage.getItem('hiro.practiceOnly')).toBe(null)
  })

  it('previews an imported file, then saves it as a deck', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeDecks = vi.fn(async () => ({ generated: [], applications: [], sizes: [10, 15, 20] }))
    window.api.previewPracticeImport = vi.fn(async () => ({
      success: true, format: 'csv', formatLabel: 'CSV', count: 2, skippedCount: 1, skipped: [{ where: 'line 4', reason: 'no answer' }],
      suggestedTitle: 'react basics',
      sample: [{ question: 'What is JSX?', answer: 'Syntax', format: 'markdown', blocks: [{ type: 'p', spans: [{ text: 'HTML-like syntax in JavaScript.' }] }] }],
    }))
    window.api.importPracticeDeck = vi.fn(async () => ({ success: true, deck: { id: 4, title: 'React basics', cards: 2, topic: 'Deck: React basics' }, skippedCount: 1 }))
    window.api.savePracticeSettings = vi.fn(async (settings) => ({ success: true, settings }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('tab', { name: 'Decks' }))
    fireEvent.click(await screen.findByRole('tab', { name: 'Import a file' }))
    const f = new File(['question,answer'], 'react_basics.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('Choose a question file'), { target: { files: [f] } })
    expect(await screen.findByText('What is JSX?')).toBeTruthy()
    expect(screen.getByText('HTML-like syntax in JavaScript.')).toBeTruthy()
    expect(screen.getByText('line 4: no answer')).toBeTruthy()
    expect(window.api.previewPracticeImport).toHaveBeenCalledWith({ name: 'react_basics.csv', text: 'question,answer' })
    fireEvent.change(screen.getByLabelText('Deck name'), { target: { value: 'React basics' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 questions' }))
    await waitFor(() => expect(window.api.importPracticeDeck).toHaveBeenCalledWith({ name: 'react_basics.csv', text: 'question,answer', title: 'React basics' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Practise this deck now' }))
    await waitFor(() => expect(window.api.savePracticeSettings).toHaveBeenCalledWith({ topics: ['Deck: React basics'], dailyCount: 8 }))
  })

  it('turns a web page into a deck', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeDecks = vi.fn(async () => ({ generated: [{ id: 2, title: 'Old', cards: 5, created_at: '2026-11-20', topic: 'Deck: Old', source: 'web-page', sourceUrl: 'https://www.example.com/a' }], applications: [], sizes: [10, 15, 20] }))
    window.api.practiceDeckFromUrl = vi.fn(async () => ({ success: true, deck: { id: 3, title: 'Event loop explained', cards: 12, topic: 'Deck: Event loop explained' } }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('tab', { name: 'Decks' }))
    expect(await screen.findByText(/from example\.com/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'From a web page' }))
    const make = screen.getByRole('button', { name: 'Make cards' })
    expect(make.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Page address'), { target: { value: 'https://example.com/event-loop' } })
    fireEvent.change(screen.getByLabelText('Number of questions from the page'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make cards' }))
    await waitFor(() => expect(window.api.practiceDeckFromUrl).toHaveBeenCalledWith({ url: 'https://example.com/event-loop', title: '', count: 10 }))
    expect(await screen.findByText(/“Event loop explained” is ready: 12 questions/)).toBeTruthy()
  })
})

describe('Practice: struggling cards, pausing, scheduler and calendar', () => {
  it('offers ways out on a card missed five times, and pauses it', async () => {
    let today = dayWith([card({ leech: true, state: { ease: 1.3, interval: 1, reps: 0, lapses: 6, dueOn: '2026-11-21' } }), card({ id: 'node-002', question: 'What is a Buffer?' })])
    window.api.getPracticeToday = vi.fn(async () => today)
    window.api.getPracticeStats = vi.fn(async () => ({ ...stats, leeches: 1 }))
    window.api.pausePracticeCard = vi.fn(async (id, paused) => {
      today = { ...dayWith(today.cards.map(c => c.id === id ? { ...c, paused } : c)), queue: ['node-002'] }
      return { success: true, paused }
    })
    const showToast = vi.fn()
    render(<Practice active showToast={showToast} />)
    expect(await screen.findByText('Missed 6 times.')).toBeTruthy()
    expect(screen.getByLabelText('Practice progress').textContent).toContain('1 struggling')
    // "Explain it differently" opens the AI panel, the banner steps aside.
    window.api.getPracticeExplanations = vi.fn(async () => [])
    window.api.explainPracticeCard = vi.fn(async () => ({ success: true, entry: { id: 1, prompt: '', reply: 'Think of it as…', blocks: [{ type: 'p', spans: [{ text: 'Think of it as…' }] }] } }))
    fireEvent.click(screen.getByRole('button', { name: '✦ Explain it differently' }))
    await waitFor(() => expect(screen.queryByText('Missed 6 times.')).toBeNull())
    // With nothing saved yet, opening the panel asks straight away.
    await waitFor(() => expect(window.api.explainPracticeCard).toHaveBeenCalledWith('node-001', ''))
    fireEvent.click(screen.getByRole('button', { name: /Ask AI/ }))
    fireEvent.click(await screen.findByRole('button', { name: '⏸ Pause it' }))
    await waitFor(() => expect(window.api.pausePracticeCard).toHaveBeenCalledWith('node-001', true))
    expect(await screen.findByText('What is a Buffer?')).toBeTruthy()
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/^Paused/), 'success')
  })

  it('shows no banner on a card that is not struggling', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    expect(screen.queryByText(/Missed \d+ times/)).toBeNull()
    expect(screen.getByRole('button', { name: '⏸ Pause' })).toBeTruthy()
  })

  it('switches to FSRS and offers a recall target', async () => {
    let settings = { topics: [], dailyCount: 8, algorithm: 'sm2', retention: 0.9 }
    window.api.getPracticeToday = vi.fn(async () => ({ ...dayWith([card()]), settings }))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.savePracticeSettings = vi.fn(async (next) => { settings = next; return { success: true, settings } })
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    expect(screen.queryByLabelText('Target recall')).toBeNull()
    fireEvent.change(screen.getByLabelText('Scheduler'), { target: { value: 'fsrs' } })
    await waitFor(() => expect(window.api.savePracticeSettings).toHaveBeenCalledWith(expect.objectContaining({ algorithm: 'fsrs' })))
    fireEvent.change(await screen.findByLabelText('Target recall'), { target: { value: '0.95' } })
    await waitFor(() => expect(window.api.savePracticeSettings).toHaveBeenLastCalledWith(expect.objectContaining({ algorithm: 'fsrs', retention: 0.95 })))
  })

  it('filters Browse to struggling and paused cards', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => stats)
    window.api.getPracticeBank = vi.fn(async () => ({
      day: '2026-11-21', topics: [{ name: 'Node.js', count: 3 }], settings: { topics: [], dailyCount: 8 }, orphanFlags: [],
      cards: [card(), card({ id: 'node-002', question: 'What is a Buffer?', leech: true }), card({ id: 'node-003', question: 'What is libuv?', paused: true })],
    }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('tab', { name: 'Browse' }))
    await screen.findByText('3 of 3 questions')
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'struggling' } })
    expect(await screen.findByText('1 of 3 questions')).toBeTruthy()
    expect(screen.getByText('What is a Buffer?')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'paused' } })
    expect(screen.getByText('What is libuv?')).toBeTruthy()
    expect(screen.getByText('Paused', { selector: '.badge' })).toBeTruthy()
  })

  it('draws the practice calendar with a square per day and a list view', () => {
    // Two weeks from Monday 9 Nov; Thursday 19th is today, so three days to come.
    const counts = [0, 2, 0, 0, 0, 0, 0, 5, 1, 0, 3, -1, -1, -1]
    render(<PracticeCalendar calendar={{ start: '2026-11-09', weeks: 2, counts, max: 5, activeDays: 4, total: 11 }} />)
    const grid = screen.getByRole('img', { name: /4 active days in the last 2 weeks, 11 cards rated/ })
    const cells = grid.querySelectorAll('.practice-cal-cell')
    expect(cells.length).toBe(14)
    expect(grid.querySelectorAll('.future').length).toBe(3)
    expect(grid.querySelectorAll('.l4').length).toBe(1)
    expect(cells[1].getAttribute('title')).toMatch(/2 cards rated/)
    expect(cells[0].getAttribute('title')).toMatch(/no practice/)
    expect(screen.getByText('4 days in the last 2 weeks · 11 cards rated')).toBeTruthy()
    // The list view says the same in words, newest first.
    const items = screen.getAllByRole('listitem', { hidden: true })
    expect(items.length).toBe(4)
    expect(items[0].textContent).toMatch(/3 cards rated/)
  })

  it('shades by share of the busiest day', () => {
    expect([0, 1, 3, 5, 9].map(n => calendarShade(n, 9))).toEqual([0, 1, 2, 3, 4])
    expect(calendarShade(-1, 4)).toBe(0)
  })

  it('shows the calendar on Insights', async () => {
    window.api.getPracticeToday = vi.fn(async () => dayWith([card()]))
    window.api.getPracticeStats = vi.fn(async () => ({ ...stats, calendar: { start: '2026-11-16', weeks: 1, counts: [1, 0, 0, 0, 0, -1, -1], max: 1, activeDays: 1, total: 1 } }))
    window.api.getPracticeInsights = vi.fn(async () => ({
      days: 90, totals: { reviews: 1, again: 0, againRate: 0, activeDays: 1 }, skillsGap: { available: false, sample: 0 }, topics: [], weakCards: [],
    }))
    render(<Practice active showToast={() => {}} />)
    await screen.findByText('What is Node.js?')
    fireEvent.click(screen.getByRole('tab', { name: 'Insights' }))
    expect(await screen.findByText('Practice days')).toBeTruthy()
  })
})
