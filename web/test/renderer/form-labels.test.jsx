// Every form control has an accessible name.
//
// The house pattern across these pages is a .form-group holding a <label> and
// then a SIBLING <input>. Siblings are not associated: clicking the label does
// nothing, and a screen reader announces the control as unlabelled. Settings
// alone has around a hundred controls, so the page read as a hundred anonymous
// boxes — and a placeholder does not fix it, because a placeholder disappears
// the moment anything is typed and is announced inconsistently at best.
//
// Asserted structurally rather than per field. A test that listed each control
// by name would have to be edited every time a setting is added, which is how a
// test like this stops being run; this one fails when a NEW unlabelled control
// appears, which is the moment worth catching.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import Setup from '../../src/pages/Setup'
import Offers from '../../src/pages/Offers'
import Workbench from '../../src/pages/Workbench'

// An input is named if it has aria-label, aria-labelledby, a title, or a
// <label htmlFor> pointing at it. A hidden input and a submit button carry
// their own name and are not in scope.
function unnamedControls(container) {
  const controls = [...container.querySelectorAll('input, select, textarea')]
  return controls.filter((el) => {
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return false
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return false
    // Explicit association.
    if (el.id && container.querySelector(`label[for="${el.id}"]`)) return false
    // Implicit association: the control sits inside its own label. This is the
    // checkbox pattern used throughout ("<label><input …/> Enabled</label>").
    if (el.closest('label')) return false
    return true
  })
}

const describeControl = (el) =>
  `<${el.tagName.toLowerCase()}${el.type ? ` type="${el.type}"` : ''}${el.placeholder ? ` placeholder="${el.placeholder}"` : ''}>`

beforeEach(() => {
  Object.assign(window.api, {
    getConfig: vi.fn(async () => ({
      setupComplete: false, resumes: [], masterResume: '', aiProvider: 'claude',
      applicationProfile: {}, atsBoards: [],
    })),
    getOffers: vi.fn(async () => []),
    getApplications: vi.fn(async () => []),
    getCampaigns: vi.fn(async () => []),
    getContacts: vi.fn(async () => []),
    getOptimisationInsights: vi.fn(async () => []),
    getCampaignAnalytics: vi.fn(async () => []),
    getProfileFields: vi.fn(async () => []),
    describeMailServers: vi.fn(async () => ({ ok: true, providerName: 'Gmail', smtp: { host: 'h', port: 465 }, imap: { host: 'i', port: 993 }, passwordHelp: '' })),
  })
})

describe('form control labelling', () => {
  it('names every control on Setup', async () => {
    const { container } = render(<Setup onComplete={() => {}} />)
    const unnamed = unnamedControls(container)
    expect(unnamed.map(describeControl)).toEqual([])
  })

  it('names every control on Offers', async () => {
    const { container, findByRole } = render(<Offers active showToast={() => {}} />)
    await findByRole('heading', { name: /offers/i })
    expect(unnamedControls(container).map(describeControl)).toEqual([])
  })

  it('names every control on Workbench', async () => {
    const { container, findByRole } = render(<Workbench active showToast={() => {}} />)
    await findByRole('heading', { name: /workbench/i })
    expect(unnamedControls(container).map(describeControl)).toEqual([])
  })
})

describe('label association', () => {
  // The failure that motivated this: a label whose htmlFor names an id that no
  // control has is worse than no label, because it looks correct in the source
  // and announces nothing.
  it('every htmlFor on Setup resolves to a control', () => {
    const { container } = render(<Setup onComplete={() => {}} />)
    const dangling = [...container.querySelectorAll('label[for]')]
      .map(l => l.getAttribute('for'))
      .filter(id => !container.querySelector(`[id="${id}"]`))
    expect(dangling).toEqual([])
  })

  // Ids have to be unique or the association silently points at the wrong
  // control. Every page in this app is mounted at once, so this matters more
  // here than in an app that unmounts as it navigates.
  it('control ids on Setup are unique', () => {
    const { container } = render(<Setup onComplete={() => {}} />)
    const ids = [...container.querySelectorAll('[id]')].map(el => el.id)
    expect(ids.length).toBe(new Set(ids).size)
  })
})
