import { useState } from 'react'

// Where to get a key, next to the box that asks for one.
//
// The step most people stall on during setup is not pasting the key — it is
// finding the page that makes one. Each provider hides it in a different place
// behind a different console, and some refuse to work until billing is set up,
// which reads as "the key is broken" when Test Connection fails.
//
// Links open in the system browser: the main window's window-open handler
// hands every http(s) target="_blank" link to shell.openExternal.

// The renderer never sees a stored key — see electron/ipc/configGuard.js.
export const SAVED_KEY = '__hiro_saved_secret__'

export const KEY_GUIDES = {
  claude: {
    name: 'Anthropic',
    url: 'https://platform.claude.com/settings/keys',
    linkText: 'Open the Claude Console',
    steps: [
      'Sign in or create an account.',
      'Add credit under Billing. A new account can\'t make requests until it has some.',
      'Under API keys, choose Create Key, name it "Hiro", and copy it.',
    ],
  },
  chatgpt: {
    name: 'OpenAI',
    url: 'https://platform.openai.com/api-keys',
    linkText: 'Open the OpenAI API keys page',
    steps: [
      'Sign in. A ChatGPT login works, but a ChatGPT Plus subscription doesn\'t cover API use.',
      'Add a payment method or credit under Settings → Billing.',
      'Choose Create new secret key, name it "Hiro", and copy it. It is only shown once.',
    ],
  },
  deepseek: {
    name: 'DeepSeek',
    url: 'https://platform.deepseek.com/api_keys',
    linkText: 'Open the DeepSeek API keys page',
    steps: [
      'Sign in or create an account.',
      'Top up your balance. Requests fail with "insufficient balance" until you do.',
      'Choose Create new API key, name it "Hiro", and copy it. It is only shown once.',
    ],
  },
  gemini: {
    name: 'Google',
    url: 'https://aistudio.google.com/app/apikey',
    linkText: 'Open Google AI Studio',
    steps: [
      'Sign in with a Google account.',
      'Choose Create API key and copy it. The free tier works without billing, but its rate limits are low.',
    ],
  },
  openrouter: {
    name: 'OpenRouter',
    url: 'https://openrouter.ai/settings/keys',
    linkText: 'Open OpenRouter keys',
    steps: [
      'Easiest: choose Sign in with OpenRouter below. Hiro gets a key billed to your own OpenRouter account, with nothing to copy.',
      'Add credit to your OpenRouter account. One account reaches Claude, GPT, Gemini and more.',
      'Or create a key on the keys page and paste it here.',
    ],
  },
  local: {
    name: 'Ollama',
    url: 'https://ollama.com/download',
    linkText: 'Download Ollama',
    steps: [
      'Install Ollama (or LM Studio) and start it.',
      'Pull a model, e.g. run: ollama pull llama3.1:8b',
      'Enter that model name below. No key is needed.',
    ],
  },
}

// A key pasted under the wrong provider is the commonest setup mistake, and the
// provider's own error ("invalid x-api-key") doesn't say which way round it is.
// Only a hint: prefixes are a convention, not a contract, so this never blocks.
export function keyMismatch(provider, key) {
  const k = String(key || '').trim()
  if (!k || k === SAVED_KEY) return null
  const looksClaude = k.startsWith('sk-ant-')
  const looksOpenRouter = k.startsWith('sk-or-')
  const looksGemini = k.startsWith('AIza')
  const looksOpenAiStyle = k.startsWith('sk-') && !looksClaude && !looksOpenRouter
  if (provider !== 'openrouter' && looksOpenRouter) return 'This looks like an OpenRouter key. Pick OpenRouter as the provider, or paste a different key.'
  if (provider === 'openrouter' && !looksOpenRouter) return 'This doesn\'t look like an OpenRouter key. OpenRouter keys start with sk-or-.'
  if (provider === 'claude' && looksOpenAiStyle) return 'This looks like an OpenAI or DeepSeek key. Claude keys start with sk-ant-.'
  if (provider === 'claude' && looksGemini) return 'This looks like a Google Gemini key. Claude keys start with sk-ant-.'
  if ((provider === 'chatgpt' || provider === 'deepseek') && looksClaude) return 'This looks like a Claude (Anthropic) key. Pick Claude as the provider, or paste a different key.'
  if ((provider === 'chatgpt' || provider === 'deepseek') && looksGemini) return 'This looks like a Google Gemini key. Pick Gemini as the provider, or paste a different key.'
  if (provider === 'gemini' && (looksClaude || looksOpenAiStyle)) return 'This doesn\'t look like a Gemini key. Gemini keys start with AIza.'
  return null
}

// The key OpenRouter issues is stored by the main process; the renderer is only
// told that it worked.
function OpenRouterSignIn({ onSignedIn }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const start = async () => {
    setBusy(true)
    setMessage('Finish signing in in your browser…')
    try {
      const res = await window.api.openRouterSignIn()
      if (res?.success) {
        setMessage('Signed in. OpenRouter is now your AI provider.')
        onSignedIn?.()
      } else {
        setMessage(res?.error || 'Sign-in did not finish.')
      }
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
      <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>
        {busy ? 'Waiting for browser…' : 'Sign in with OpenRouter'}
      </button>
      {busy && (
        <button type="button" className="btn btn-ghost" onClick={() => window.api.openRouterCancel()}>Cancel</button>
      )}
      {message && <span role="status" aria-live="polite">{message}</span>}
    </div>
  )
}

const boxStyle = {
  fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-subtle)',
  border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', marginBottom: 12,
}

export default function ApiKeyHelp({ provider, apiKey, onSignedIn }) {
  const guide = KEY_GUIDES[provider]
  if (!guide) return null
  const mismatch = provider === 'local' ? null : keyMismatch(provider, apiKey)
  return (
    <div style={boxStyle} data-testid="api-key-help">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ color: 'var(--text)', fontSize: 12 }}>
          {provider === 'local' ? 'Set up a local model' : `Get a ${guide.name} API key`}
        </strong>
        <a href={guide.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {guide.linkText} ↗
        </a>
      </div>
      <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
        {guide.steps.map(s => <li key={s}>{s}</li>)}
        {provider !== 'local' && <li>Paste it here, then choose Test Connection.</li>}
      </ol>
      {provider === 'openrouter' && <OpenRouterSignIn onSignedIn={onSignedIn} />}
      {apiKey === SAVED_KEY && provider !== 'local' && (
        <div style={{ marginTop: 6 }}>A {guide.name} key is saved. Paste a new one only to replace it.</div>
      )}
      {mismatch && (
        <div role="alert" style={{ color: 'var(--yellow, var(--red))', marginTop: 6 }}>{mismatch}</div>
      )}
    </div>
  )
}
