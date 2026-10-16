// Job links arriving from outside the app: the Android share sheet ("Share →
// Hiro" from a browser or job-board app) and hiro://import?url=… deep links
// (an iOS Shortcut, a link in a note, a QR code).
//
// iOS has no share-sheet entry yet: expo-share-intent builds it as a share
// extension, which needs an App Group on the Apple developer account and an
// extra EAS build target. Until that exists, iOS uses the deep link and the
// Dashboard's "Import job from clipboard". See app.json (disableIOS).
import { useEffect, useRef } from 'react'
import { Platform, Linking } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { useShareIntent } from 'expo-share-intent'
import { extractJobUrl, parseImportLink } from './importLink'

// Expo Go has no share-intent native module; the hook is told so rather than
// left to discover it.
const SHARE_DISABLED = Platform.OS !== 'android'
  || Constants.executionEnvironment === ExecutionEnvironment.StoreClient

export function useIncomingImports(onJob) {
  const onJobRef = useRef(onJob)
  onJobRef.current = onJob

  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({ disabled: SHARE_DISABLED })
  useEffect(() => {
    if (!hasShareIntent) return
    const url = shareIntent?.webUrl || extractJobUrl(shareIntent?.text)
    const title = shareIntent?.meta?.title || ''
    resetShareIntent()
    onJobRef.current(url ? { url, title } : null)
  }, [hasShareIntent, shareIntent, resetShareIntent])

  useEffect(() => {
    const handle = (link) => {
      const job = parseImportLink(link)
      if (job) onJobRef.current(job)
    }
    // The link that launched the app, then any that arrive while it runs.
    Linking.getInitialURL().then(handle).catch(() => {})
    const sub = Linking.addEventListener('url', ({ url }) => handle(url))
    return () => sub.remove()
  }, [])
}
