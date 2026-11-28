// The recommended local models in Settings: a download button for each model
// the server lacks, progress while it downloads, and the model chosen once it
// is there. And the "Other skills you have" picker, which is ticked, not typed.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import LocalModels from '../../src/components/LocalModels'
import { ExtraSkills } from '../../src/pages/settings/ExtraSkills'

const SMALL = { id: 'qwen2.5:7b', name: 'Qwen2.5 7B', size: '4.7 GB', needs: '', note: '' }
const BIG = { id: 'qwen3:30b-a3b-instruct-2507-q4_K_M', name: 'Qwen3 30B-A3B', size: '18 GB', needs: '', note: '' }

describe('LocalModels', () => {
  let progress
  beforeEach(() => {
    progress = null
    window.api.onLocalModelPullProgress = vi.fn(cb => { progress = cb; return () => {} })
    window.api.cancelLocalModelPull = vi.fn(async () => ({ success: true }))
  })

  it('offers to use a model the server has, and to download one it lacks', async () => {
    window.api.localAiStatus = vi.fn(async () => ({
      success: true, running: true, root: 'http://localhost:11434',
      recommended: [{ ...SMALL, installed: true }, { ...BIG, installed: false }],
    }))
    const onUse = vi.fn()
    render(<LocalModels baseUrl="http://localhost:11434/v1" value="" onUse={onUse} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Use' }))
    expect(onUse).toHaveBeenCalledWith(SMALL.id)
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
  })

  it('shows progress while downloading, then chooses the model', async () => {
    let installed = false
    window.api.localAiStatus = vi.fn(async () => ({
      success: true, running: true, root: 'http://localhost:11434',
      recommended: [{ ...BIG, installed }],
    }))
    let finish
    window.api.pullLocalModel = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const onUse = vi.fn()
    render(<LocalModels baseUrl="http://localhost:11434/v1" value="qwen2.5:7b" onUse={onUse} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))
    expect(window.api.pullLocalModel).toHaveBeenCalledWith(BIG.id, { localAiBaseUrl: 'http://localhost:11434/v1' })
    progress({ model: BIG.id, status: 'pulling', total: 18e9, completed: 4.5e9 })
    expect(await screen.findByText('25% · 4.5 of 18.0 GB')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
    installed = true
    finish({ success: true })
    await waitFor(() => expect(onUse).toHaveBeenCalledWith(BIG.id))
  })

  it('says how to get Ollama when nothing answers', async () => {
    window.api.localAiStatus = vi.fn(async () => ({
      success: true, running: false, root: 'http://localhost:11434',
      recommended: [{ ...SMALL, installed: false }],
    }))
    render(<LocalModels baseUrl="" value="" onUse={() => {}} />)
    expect((await screen.findByRole('link', { name: 'Install Ollama' })).getAttribute('href')).toBe('https://ollama.com/download')
    expect(screen.getByRole('button', { name: 'Download' }).disabled).toBe(true)
  })
})

describe('ExtraSkills', () => {
  const choices = {
    sample: 2,
    hasResume: true,
    groups: [
      { group: 'Data and AI', skills: [
        { name: 'PostgreSQL', onResume: true, ads: 2, ticked: false },
        { name: 'SQL Server', onResume: false, ads: 2, ticked: false },
        { name: 'Snowflake', onResume: false, ads: 0, ticked: false },
      ] },
    ],
  }

  it('lists what the résumé lacks, leads with what ads ask for, and ticks without typing', async () => {
    window.api.getSkillChoices = vi.fn(async () => choices)
    const set = vi.fn()
    render(<ExtraSkills form={{ extraSkills: [] }} set={set} />)
    const asked = await screen.findByText('Asked for in your recent job ads')
    expect(asked).toBeTruthy()
    expect(screen.queryByRole('button', { name: /PostgreSQL/ })).toBeNull()
    expect(screen.getByText(/1 skill is already on your résumé/)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /SQL Server/ })[0])
    expect(set).toHaveBeenCalledWith('extraSkills', ['SQL Server'])
  })

  it('unticks a ticked skill', async () => {
    window.api.getSkillChoices = vi.fn(async () => choices)
    const set = vi.fn()
    render(<ExtraSkills form={{ extraSkills: ['Snowflake'] }} set={set} />)
    const chip = await screen.findByRole('button', { name: 'Snowflake' })
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chip)
    expect(set).toHaveBeenCalledWith('extraSkills', [])
  })
})
