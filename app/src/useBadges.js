// The counts on the tab bar: follow-ups due (Dashboard), drafts waiting for a
// decision (Applications), and offers whose deadline is within three days
// (Offers). The arithmetic is in listing.js, where it is tested; this is only
// the fetching.
//
// Refreshed on sign-in, when the app comes back to the foreground, on tab
// changes (throttled — a tab bar that costs three requests per tap is not worth
// having), and immediately after anything on the phone changes one of the
// counts.
import { useState, useEffect, useCallback, useRef } from 'react'
import { AppState } from 'react-native'
import { deriveBadges } from './listing'

const NONE = { dashboard: 0, applications: 0, offers: 0 }
const MIN_INTERVAL_MS = 20000

// Each source degrades to "nothing" on its own. A badge is a hint; one that
// fails must never take the others down, or surface an error of its own.
const quietly = async (fn) => {
  try { return await fn() } catch { return null }
}

export function useBadges(client, tab) {
  const [badges, setBadges] = useState(NONE)
  const lastAt = useRef(0)
  // Guards against an older, slower response landing after a newer one.
  const seq = useRef(0)

  const refresh = useCallback(async (force = false) => {
    if (!client) return
    if (!force && Date.now() - lastAt.current < MIN_INTERVAL_MS) return
    lastAt.current = Date.now()
    const mine = ++seq.current
    const [stats, due, offers] = await Promise.all([
      quietly(() => client.getStats()),
      quietly(() => (client.getDueActions ? client.getDueActions() : [])),
      quietly(() => (client.getOffers ? client.getOffers() : null)),
    ])
    if (mine === seq.current) setBadges(deriveBadges({ stats, due, offers }))
  }, [client])

  // A new connection (or a sign-out) starts from nothing rather than showing
  // the previous account's counts until the first fetch lands.
  useEffect(() => {
    setBadges(NONE)
    lastAt.current = 0
    refresh(true)
  }, [refresh])

  useEffect(() => { refresh(false) }, [tab, refresh])

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh(true)
    })
    return () => sub.remove()
  }, [refresh])

  const refreshNow = useCallback(() => refresh(true), [refresh])
  return [badges, refreshNow]
}
