// Practice, on the phone: the desktop's interview flashcards.
//
// The same daily set as the desktop's Practice page, over the paired Wi-Fi
// connection — the schedule (SM-2) lives in the desktop's database, so a card
// rated here is done on the desktop too. Answers arrive as text blocks (the
// desktop's practiceCore.answerBlocks), never as HTML, so nothing in a question
// bank can become markup here.
//
// What stays on the desktop: choosing topics, browsing and searching the bank,
// and restoring reported cards.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, RefreshControl, Platform,
} from 'react-native'
import { radius, useTheme } from '../theme'
import { messageFor } from '../requestErrors'
import { randomKey } from '../secureProtocol'
import * as haptics from '../haptics'
import { formatInterval, statsLine, currentCard } from '../practice'

const RATINGS = [
  { key: 'again', label: 'Again', hint: 'Forgot it' },
  { key: 'hard', label: 'Hard', hint: 'With effort' },
  { key: 'good', label: 'Good', hint: 'Got it' },
  { key: 'easy', label: 'Easy', hint: 'Instant' },
]

function Blocks({ blocks, styles }) {
  if (!blocks?.length) return <Text style={styles.muted}>No sample answer yet. Write your own in the application&apos;s interview prep on the desktop.</Text>
  return blocks.map((b, i) => {
    const spans = b.spans.map((s, j) => (
      <Text key={j} style={[s.bold && styles.bold, s.italic && styles.italic, s.code && b.type !== 'pre' && styles.inlineCode]}>{s.text}</Text>
    ))
    if (b.type === 'pre') {
      return (
        <ScrollView key={i} horizontal style={styles.pre} contentContainerStyle={styles.preContent}>
          <Text style={styles.preText}>{spans}</Text>
        </ScrollView>
      )
    }
    if (b.type === 'li') {
      return (
        <View key={i} style={styles.li}>
          <Text style={styles.bullet}>{b.marker}</Text>
          <Text style={[styles.body, styles.liText]}>{spans}</Text>
        </View>
      )
    }
    return <Text key={i} style={[styles.body, styles.para]}>{spans}</Text>
  })
}

export default function PracticeScreen({ client, active }) {
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [data, setData] = useState(null)
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState('')

  const load = useCallback(async () => {
    if (!client?.canPractice) return
    try {
      setData(await client.getPractice())
      setError('')
      setUnavailable('')
    } catch (err) {
      if (Number(err.status) === 404) setUnavailable('Update Hiro on the desktop to practise from your phone.')
      else setError(messageFor(err))
    }
  }, [client])

  useEffect(() => { if (active) load() }, [active, load])

  const current = currentCard(data)
  useEffect(() => { setRevealed(false) }, [current?.id])

  async function refresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  async function rate(rating) {
    if (!current || busy) return
    setBusy(true)
    haptics.selection()
    try {
      const res = await client.ratePracticeCard(current.id, rating, { idempotencyKey: randomKey() })
      if (res?.practice) setData(res.practice)
      else await load()
      setError('')
    } catch (err) {
      haptics.failure()
      // 403: this phone was paired read-only, which allows looking but not rating.
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  async function practiseMore() {
    setBusy(true)
    try {
      setData(await client.practiceMore(data.dailyCount, { idempotencyKey: randomKey() }))
      setError('')
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  function report() {
    if (!current) return
    const send = async (reason) => {
      try {
        const res = await client.flagPracticeCard(current.id, reason)
        if (res?.practice) setData(res.practice)
        haptics.success()
      } catch (err) { setError(messageFor(err)) }
    }
    Alert.alert('Report this card', 'It leaves your practice until you restore it on the desktop.', [
      { text: 'Outdated', onPress: () => send('outdated') },
      { text: 'Wrong', onPress: () => send('wrong') },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  if (!client?.canPractice) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Text style={styles.title}>Practice</Text>
        <Text style={styles.muted}>Practice works when your phone is paired with the desktop over Wi-Fi. Connect on the same network as the desktop to use it.</Text>
      </View>
    )
  }
  if (unavailable) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Text style={styles.title}>Practice</Text>
        <Text style={styles.muted}>{unavailable}</Text>
      </View>
    )
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textMuted} />}>
      <Text style={styles.title} accessibilityRole="header">Practice</Text>
      {!!data?.stats && <Text style={styles.muted}>{statsLine(data.stats)}</Text>}
      {!!error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}

      {!data && !error && <ActivityIndicator style={{ marginTop: 32 }} color={colors.textMuted} />}

      {!!data && !current && (
        <View style={[styles.card, styles.doneCard]}>
          <Text style={styles.doneTitle}>{data.cards.length ? 'Done for today' : 'No cards for these topics'}</Text>
          <Text style={[styles.muted, { textAlign: 'center' }]}>
            {data.cards.length
              ? `${data.doneCount} card${data.doneCount === 1 ? '' : 's'} reviewed. Come back tomorrow for the next set.`
              : 'Choose more topics on the desktop’s Practice page.'}
            {data.dueLater > 0 ? ` ${data.dueLater} more due.` : ''}
          </Text>
          {data.available > 0 && (
            <TouchableOpacity style={[styles.button, styles.buttonPrimary, { marginTop: 14 }]} onPress={practiseMore} disabled={busy}
              accessibilityRole="button">
              <Text style={styles.buttonPrimaryText}>Practise {Math.min(data.dailyCount, data.available)} more</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {!!current && (
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.topic} numberOfLines={1}>{current.deck === 'job' ? `Job: ${current.topic}` : current.topic}</Text>
            <Text style={styles.position}>{data.doneCount + 1} of {data.cards.length}</Text>
          </View>
          <View style={styles.tags}>
            {!!current.difficulty && <Text style={styles.tag}>{current.difficulty}</Text>}
            {current.versions?.map(v => <Text key={v} style={styles.tag}>{v}</Text>)}
            <Text style={styles.tag}>{current.isNew ? 'New' : 'Review'}</Text>
          </View>
          <Text style={styles.question}>{current.question}</Text>

          {!revealed ? (
            <TouchableOpacity style={[styles.button, styles.buttonPrimary]} onPress={() => setRevealed(true)} accessibilityRole="button">
              <Text style={styles.buttonPrimaryText}>Show answer</Text>
            </TouchableOpacity>
          ) : (
            <>
              <View style={styles.answer}><Blocks blocks={current.blocks} styles={styles} /></View>
              <View style={styles.ratings}>
                {RATINGS.map(r => (
                  <TouchableOpacity key={r.key} disabled={busy} onPress={() => rate(r.key)}
                    style={[styles.rating, r.key === 'again' && styles.ratingAgain, r.key === 'good' && styles.ratingGood]}
                    accessibilityRole="button"
                    accessibilityLabel={`${r.label}, ${r.hint}. Back in ${formatInterval(current.intervals[r.key])}`}>
                    <Text style={[styles.ratingLabel, (r.key === 'again' || r.key === 'good') && styles.ratingLabelStrong]}>{r.label}</Text>
                    <Text style={[styles.ratingHint, (r.key === 'again' || r.key === 'good') && styles.ratingLabelStrong]}>{formatInterval(current.intervals[r.key])}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}
          <TouchableOpacity onPress={report} style={styles.reportLink} accessibilityRole="button">
            <Text style={styles.reportText}>Report outdated or wrong</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  )
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace'

// Rebuilt per palette — see useTheme() in ../theme.
const makeStyles = (c) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  content: { padding: 16, paddingBottom: 32 },
  centered: { padding: 24, justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: '700', color: c.text, marginBottom: 6 },
  muted: { color: c.textMuted, fontSize: 13, lineHeight: 19 },
  error: { color: c.red, fontSize: 13, marginTop: 8 },

  card: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius, padding: 16, marginTop: 14 },
  doneCard: { alignItems: 'center', paddingVertical: 28 },
  doneTitle: { color: c.text, fontSize: 18, fontWeight: '700', marginBottom: 6 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  topic: { color: c.accent, fontSize: 12.5, fontWeight: '600', flex: 1 },
  position: { color: c.textFaint, fontSize: 12 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  tag: { color: c.textMuted, fontSize: 11.5, borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  question: { color: c.text, fontSize: 18, fontWeight: '700', lineHeight: 25, marginTop: 12, marginBottom: 16 },

  button: { borderRadius: radius, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  buttonPrimary: { backgroundColor: c.accent },
  buttonPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  answer: { borderTopWidth: 1, borderTopColor: c.border, paddingTop: 14, marginBottom: 16 },
  body: { color: c.text, fontSize: 14.5, lineHeight: 21 },
  para: { marginBottom: 10 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  inlineCode: { fontFamily: mono, fontSize: 13, backgroundColor: c.surface2 },
  li: { flexDirection: 'row', gap: 8, marginBottom: 6, paddingRight: 4 },
  bullet: { color: c.textMuted, fontSize: 14.5, lineHeight: 21, minWidth: 14 },
  liText: { flex: 1 },
  pre: { backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border, borderRadius: 8, marginBottom: 10 },
  preContent: { padding: 10 },
  preText: { fontFamily: mono, fontSize: 12.5, lineHeight: 18, color: c.text },

  ratings: { flexDirection: 'row', gap: 8 },
  rating: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: radius, paddingVertical: 10, alignItems: 'center', minHeight: 52, justifyContent: 'center', backgroundColor: c.surface2 },
  ratingAgain: { backgroundColor: c.red, borderColor: c.red },
  ratingGood: { backgroundColor: c.accent, borderColor: c.accent },
  ratingLabel: { color: c.text, fontSize: 14, fontWeight: '600' },
  ratingHint: { color: c.textMuted, fontSize: 11.5, marginTop: 2 },
  ratingLabelStrong: { color: '#fff' },

  reportLink: { marginTop: 14, alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  reportText: { color: c.textMuted, fontSize: 12.5, textDecorationLine: 'underline' },
})
