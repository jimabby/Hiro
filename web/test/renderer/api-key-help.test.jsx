// The "Get a key" box next to the API key field, the model picker, and how
// Settings swaps keys when the provider changes.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import ApiKeyHelp, { KEY_GUIDES, keyMismatch, SAVED_KEY } from '../../src/components/ApiKeyHelp'
import ModelPicker from '../../src/components/ModelPicker'

describe('ApiKeyHelp', () => {
  it('links each provider to its own key page, opened in the browser', () => {
    for (const provider of ['claude', 'chatgpt', 'deepseek', 'gemini', 'openrouter', 'local']) {
      const { container, unmount } = render(<ApiKeyHelp provider={provider} apiKey="" />)
      const link = container.querySelector('a')
      expect(link.getAttribute('href')).toBe(KEY_GUIDES[provider].url)
      expect(link.getAttribute('href')).toMatch(/^https:\/\//)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(container.querySelectorAll('li').length).toBeGreaterThan(1)
      unmount()
    }
  })

  it('renders nothing for an unknown provider', () => {
    const { container } = render(<ApiKeyHelp provider="nope" apiKey="" />)
    expect(container.innerHTML).toBe('')
  })

  it('flags a key pasted under the wrong provider', () => {
    expect(keyMismatch('claude', 'sk-proj-abc')).toMatch(/OpenAI/)
    expect(keyMismatch('chatgpt', 'sk-ant-abc')).toMatch(/Claude/)
    expect(keyMismatch('deepseek', 'AIzaXYZ')).toMatch(/Gemini/)
    expect(keyMismatch('gemini', 'sk-abc')).toMatch(/AIza/)
    expect(keyMismatch('claude', 'sk-or-v1-abc')).toMatch(/OpenRouter/)
    expect(keyMismatch('openrouter', 'sk-ant-abc')).toMatch(/sk-or-/)
  })

  it('accepts keys that match their provider, and never judges the stored-key placeholder', () => {
    expect(keyMismatch('claude', 'sk-ant-abc')).toBeNull()
    expect(keyMismatch('chatgpt', 'sk-proj-abc')).toBeNull()
    expect(keyMismatch('deepseek', 'sk-abc')).toBeNull()
    expect(keyMismatch('gemini', 'AIzaXYZ')).toBeNull()
    expect(keyMismatch('openrouter', 'sk-or-v1-abc')).toBeNull()
    expect(keyMismatch('claude', SAVED_KEY)).toBeNull()
    expect(keyMismatch('gemini', '')).toBeNull()
  })

  it('says when a key is already saved for the provider', () => {
    const { container } = render(<ApiKeyHelp provider="claude" apiKey={SAVED_KEY} />)
    expect(container.textContent).toMatch(/Anthropic key is saved/)
  })

  it('signs in with OpenRouter and reports it, without the key reaching the page', async () => {
    Object.assign(window.api, { openRouterSignIn: vi.fn().mockResolvedValue({ success: true }), openRouterCancel: vi.fn() })
    const onSignedIn = vi.fn()
    const { getByText, findByText } = render(<ApiKeyHelp provider="openrouter" apiKey="" onSignedIn={onSignedIn} />)
    fireEvent.click(getByText('Sign in with OpenRouter'))
    await findByText(/OpenRouter is now your AI provider/)
    expect(onSignedIn).toHaveBeenCalled()
  })

  it('shows why an OpenRouter sign-in failed', async () => {
    Object.assign(window.api, { openRouterSignIn: vi.fn().mockResolvedValue({ success: false, error: 'Timed out' }), openRouterCancel: vi.fn() })
    const { getByText, findByText } = render(<ApiKeyHelp provider="openrouter" apiKey="" />)
    fireEvent.click(getByText('Sign in with OpenRouter'))
    await findByText('Timed out')
  })
})

describe('ModelPicker', () => {
  beforeEach(() => {
    Object.assign(window.api, { listAiModels: vi.fn().mockResolvedValue({ success: true, models: [{ id: 'gemini-3-flash', label: 'Gemini 3 Flash' }] }) })
  })

  it('loads the models the key can use into the menu', async () => {
    const { getByText, container, findByText } = render(
      <ModelPicker id="m" label="Model" value="" onChange={() => {}} provider="gemini" apiKey={SAVED_KEY} />,
    )
    fireEvent.click(getByText('Load models'))
    await findByText(/1 models available/)
    expect(window.api.listAiModels).toHaveBeenCalledWith('gemini', SAVED_KEY, undefined)
    expect(container.querySelector('datalist option').getAttribute('value')).toBe('gemini-3-flash')
  })

  it('shows the provider\'s error', async () => {
    window.api.listAiModels.mockResolvedValue({ success: false, error: 'The key was refused' })
    const { getByText, findByRole } = render(
      <ModelPicker id="m" label="Model" value="" onChange={() => {}} provider="gemini" apiKey="bad" />,
    )
    fireEvent.click(getByText('Load models'))
    expect((await findByRole('alert')).textContent).toMatch(/refused/)
  })

  it('offers the built-in menu until a list is loaded', () => {
    const { container } = render(
      <ModelPicker id="m" label="Model" value="" onChange={() => {}} provider="claude" apiKey=""
        choices={[{ id: 'claude-sonnet-5-5', label: 'Sonnet' }]} />,
    )
    expect(container.querySelector('datalist option').getAttribute('value')).toBe('claude-sonnet-5-5')
  })
})

describe('Settings provider switch', () => {
  it('shows the key saved for the new provider, not the last one', async () => {
    const { default: Settings } = await import('../../src/pages/Settings')
    const cfg = {
      setupComplete: true, aiProvider: 'claude', aiApiKey: SAVED_KEY,
      aiApiKeys: { claude: SAVED_KEY, gemini: SAVED_KEY },
      resumes: [], webhooks: [], applicationProfile: {}, atsBoards: [],
    }
    Object.assign(window.api, {
      getConfig: vi.fn(async () => cfg),
      getModelChoices: vi.fn(async () => ({ choices: {}, defaults: {} })),
      linkedinStatus: vi.fn(async () => ({ loggedIn: false })),
      seekStatus: vi.fn(async () => ({ loggedIn: false })),
      indeedStatus: vi.fn(async () => ({ loggedIn: false })),
      getMobileInfo: vi.fn(async () => ({ enabled: false })),
      cloudStatus: vi.fn(async () => ({ signedIn: false })),
      calendarSyncStatus: vi.fn(async () => ({ connected: false, providers: [] })),
      getEncryptionStatus: vi.fn(async () => ({ enabled: false, keychainAvailable: true, backupCount: 0 })),
      getUpdateStatus: vi.fn(async () => ({ currentVersion: '9.9.9', updateAvailable: false })),
      describeMailServers: vi.fn(async () => ({ ok: true, providerName: 'Gmail', smtp: { host: 'h', port: 465 }, imap: { host: 'i', port: 993 }, passwordHelp: '' })),
      getTrayStatus: vi.fn(async () => ({ available: true })),
    })
    const { container, findByLabelText } = render(<Settings active showToast={() => {}} />)
    const select = await findByLabelText('Provider')
    fireEvent.change(select, { target: { value: 'chatgpt' } })
    await waitFor(() => expect(container.querySelector('#set-f6').value).toBe(''))
    fireEvent.change(select, { target: { value: 'gemini' } })
    await waitFor(() => expect(container.querySelector('#set-f6').value).toBe(SAVED_KEY))
  })
})
