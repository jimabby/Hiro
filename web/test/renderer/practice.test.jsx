import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import SafeAnswer from '../../src/components/SafeAnswer'
import Practice, { formatInterval } from '../../src/pages/Practice'
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
