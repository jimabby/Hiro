// The local models Hiro recommends, and downloading one through Ollama.
//
// Not bundled with the installer: the models worth using are 5 to 18 GB, more
// than an installer should carry, and which one a computer can run depends on
// its memory. So Settings recommends two, measured on the same eight job ads
// with a real résumé, and asks Ollama to download the one the user picks (its
// /api/pull), showing the progress. LM Studio and llama.cpp serve the same chat
// API but cannot be asked to download; with them a model is chosen by name.
//
// A model Hiro trains itself would join this list, published where Ollama can
// pull it from.

const { DEFAULT_BASE_URL } = require('./local')

const RECOMMENDED = [
  {
    id: 'qwen2.5:7b',
    name: 'Qwen2.5 7B',
    size: '4.7 GB',
    needs: 'Runs with 16 GB of memory, much faster with a graphics card.',
    note: 'About 17 seconds per matching job. Scores jobs well, but its tailoring is often held for review.',
  },
  {
    id: 'qwen3:30b-a3b-instruct-2507-q4_K_M',
    name: 'Qwen3 30B-A3B',
    size: '18 GB',
    needs: 'Needs 32 GB of memory.',
    note: 'About a minute per matching job. Keeps to the tailoring rules far better.',
  },
]

// Ollama's own API lives beside the OpenAI-compatible one: /api, not /v1.
function ollamaRoot(baseUrl) {
  let url
  try { url = new URL(String(baseUrl || DEFAULT_BASE_URL).trim()) } catch { throw new Error('The local server address is not a valid URL.') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The local server address must start with http:// or https://.')
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`
}

// Ollama names a model without a tag "<name>:latest".
const hasModel = (installed, id) => installed.includes(id) || (!id.includes(':') && installed.includes(`${id}:latest`))

// Whether Ollama answers at that address, what it already has, and the
// recommended models marked installed or not.
async function status(baseUrl, { fetchImpl = fetch } = {}) {
  const root = ollamaRoot(baseUrl)
  const offline = { running: false, root, installed: [], recommended: RECOMMENDED.map(m => ({ ...m, installed: false })) }
  let version = ''
  try {
    const res = await fetchImpl(`${root}/api/version`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return offline
    version = String((await res.json())?.version || '')
  } catch {
    return offline
  }
  let installed = []
  try {
    const res = await fetchImpl(`${root}/api/tags`, { signal: AbortSignal.timeout(5000) })
    const body = res.ok ? await res.json() : {}
    installed = (body?.models || []).map(m => m?.name || m?.model).filter(n => typeof n === 'string')
  } catch { /* running, but the list did not come back: show nothing as installed */ }
  return { running: true, version, root, installed, recommended: RECOMMENDED.map(m => ({ ...m, installed: hasModel(installed, m.id) })) }
}

const pulls = new Map() // model id → AbortController, while downloading

// Downloads one recommended model. Ollama streams one JSON object per line:
// a status, and for each layer its digest with total and completed bytes.
// `onProgress` gets the sum over layers, at most four times a second.
async function pull(baseUrl, model, { onProgress = () => {}, fetchImpl = fetch } = {}) {
  if (!RECOMMENDED.some(m => m.id === model)) throw new Error('Only the recommended models can be downloaded from here.')
  if (pulls.has(model)) throw new Error('That model is already downloading.')
  const root = ollamaRoot(baseUrl)
  const controller = new AbortController()
  pulls.set(model, controller)
  const layers = new Map()
  const report = (statusText) => {
    let total = 0
    let completed = 0
    for (const layer of layers.values()) { total += layer.total; completed += layer.completed }
    onProgress({ model, status: statusText, total, completed })
  }
  try {
    const res = await fetchImpl(`${root}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`Ollama refused the download (HTTP ${res.status}).`)
    const decoder = new TextDecoder()
    let buffer = ''
    let lastReport = 0
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        if (msg.error) throw new Error(`Ollama could not download ${model}: ${msg.error}`)
        if (msg.digest && Number(msg.total) > 0) layers.set(msg.digest, { total: Number(msg.total), completed: Number(msg.completed) || 0 })
        if (msg.status === 'success') {
          report('success')
          return { success: true }
        }
        if (Date.now() - lastReport >= 250) {
          lastReport = Date.now()
          report(String(msg.status || ''))
        }
      }
    }
    throw new Error('The download stopped before Ollama said it had finished.')
  } catch (err) {
    if (controller.signal.aborted) return { success: false, cancelled: true }
    throw err
  } finally {
    pulls.delete(model)
  }
}

function cancel(model) {
  pulls.get(model)?.abort()
  return { success: true }
}

module.exports = { RECOMMENDED, ollamaRoot, status, pull, cancel }
