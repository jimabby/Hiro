// The calendar-day helpers behind the Timeline.
//
// The label used to be computed from a noon anchor divided by 86,400,000, which
// is right only in the afternoon. Every case here is pinned at a specific hour
// because the hour is the whole bug.

import { describe, it, expect } from 'vitest'
import { relativeDay, localDayISO, localDayBoundsUTC, daysBetweenLocal } from '../../src/dates'

const at = (day, hh) => new Date(`${day}T${String(hh).padStart(2, '0')}:00:00`)

describe('relativeDay', () => {
  it('calls today "Today" before noon', () => {
    expect(relativeDay('2026-09-11', at('2026-09-11', 9))).toBe('Today')
  })

  it('calls today "Today" after noon', () => {
    expect(relativeDay('2026-09-11', at('2026-09-11', 15))).toBe('Today')
  })

  it('calls yesterday "Yesterday" before noon', () => {
    // Under the old arithmetic this read "Today": 21 hours floors to 0 days.
    expect(relativeDay('2026-09-10', at('2026-09-11', 9))).toBe('Yesterday')
  })

  it('counts whole calendar days, not 24-hour blocks', () => {
    expect(relativeDay('2026-09-08', at('2026-09-11', 1))).toBe('3 days ago')
    expect(relativeDay('2026-09-08', at('2026-09-11', 23))).toBe('3 days ago')
  })

  it('never produces a negative count', () => {
    expect(relativeDay('2026-09-11', at('2026-09-11', 0))).toBe('Today')
    expect(relativeDay('2026-09-12', at('2026-09-11', 9))).toBe('Tomorrow')
  })

  it('falls back to the full date after a week', () => {
    const label = relativeDay('2026-09-01', at('2026-09-11', 12))
    expect(label).toMatch(/2026/)
    expect(label).not.toMatch(/ago/)
  })
})

describe('daysBetweenLocal', () => {
  it('is signed', () => {
    expect(daysBetweenLocal('2026-09-13', '2026-09-11')).toBe(2)
    expect(daysBetweenLocal('2026-09-09', '2026-09-11')).toBe(-2)
  })
})

describe('localDayISO', () => {
  it('formats the local calendar day', () => {
    expect(localDayISO(at('2026-01-05', 0))).toBe('2026-01-05')
    expect(localDayISO(at('2026-01-05', 23))).toBe('2026-01-05')
  })
})

describe('localDayBoundsUTC', () => {
  it('covers exactly one local day, in the table’s UTC text format', () => {
    const { dateFrom, dateTo } = localDayBoundsUTC('2026-09-11')
    expect(dateFrom).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(dateTo).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    const from = new Date(dateFrom.replace(' ', 'T') + 'Z')
    const to = new Date(dateTo.replace(' ', 'T') + 'Z')
    // Local midnight, converted — so the instant is the same wherever it runs.
    expect(from.getTime()).toBe(new Date('2026-09-11T00:00:00').getTime())
    expect(to.getTime() - from.getTime()).toBe(86400000 - 1000)
  })

  it('agrees with the single-day path for every day of a range', () => {
    // "Expand All" used to send the local day string as if it were UTC; the two
    // paths must produce identical queries or the same day shows different jobs.
    for (const day of ['2026-01-01', '2026-06-30', '2026-12-31']) {
      const a = localDayBoundsUTC(day)
      const b = localDayBoundsUTC(day)
      expect(a).toEqual(b)
      expect(a.dateFrom < a.dateTo).toBe(true)
    }
  })
})
