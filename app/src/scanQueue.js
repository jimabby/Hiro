// Offline queue for scan requests. When the desktop is unreachable, scan
// requests are stored on the phone and delivered the next time we connect.
import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = 'hiro.pendingScans'

export async function getPending() {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

async function setPending(list) {
  await AsyncStorage.setItem(KEY, JSON.stringify(list))
}

export async function enqueue(req) {
  const list = await getPending()
  list.push(req)
  await setPending(list)
}

// Try to deliver every pending request to the desktop. Anything that fails
// (desktop still offline) stays queued. Returns the number delivered.
export async function flush(client) {
  const list = await getPending()
  if (list.length === 0) return 0
  let delivered = 0
  const remaining = []
  for (const req of list) {
    try {
      await client.requestScan({ keywords: req.keywords, location: req.location })
      delivered++
    } catch {
      remaining.push(req)
    }
  }
  await setPending(remaining)
  return delivered
}
