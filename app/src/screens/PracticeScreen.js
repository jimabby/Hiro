// Practice, on the phone: the desktop's interview flashcards.
//
// The same daily set as the desktop's Practice page, over the paired Wi-Fi
// connection — the schedule (SM-2) lives in the desktop's database, so a card
// rated here is done on the desktop too. Answers arrive as text blocks (the
// desktop's practiceCore.answerBlocks), never as HTML, so nothing in a question
// bank can become markup here.
//
// Each card can carry the user's note (saved on the desktop, so it shows on
// both) and can be explained further by the AI — the same stored answers the
// desktop shows, and asking more spends on the desktop's AI key, so only a
// paired phone may.
//
// What stays on the desktop: choosing topics, browsing and searching the bank,
// generating decks from a job ad, and restoring reported cards.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, RefreshControl, Platform, TextInput,
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

// Note, Ask AI and Report for one card.
function CardExtras({ client, card, styles, colors, onReport }) {
  const [panel, setPanel] = useState(null) // 'note' | 'ask'
  const [note, setNote] = useState(card.note || '')
  const [draft, setDraft] = useState(card.note || '')
  const [entries, setEntries] = useState(null)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setPanel(null); setNote(card.note || ''); setDraft(card.note || ''); setEntries(null); setQuestion(''); setError('')
  }, [card.id, card.note])

  async function saveNote() {
    setBusy(true)
    try {
      const res = await client.savePracticeNote(card.id, draft)
      setNote(res?.note || '')
      setDraft(res?.note || '')
      setPanel(null)
      haptics.success()
    } catch (err) {
      haptics.failure()
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  async function ask(followUp = '') {
    setBusy(true); setError('')
    try {
      const res = await client.explainPracticeCard(card.id, followUp, { idempotencyKey: randomKey() })
      if (!res?.success) setError(res?.error || 'The AI request failed.')
      else { setEntries(list => [...(list || []), res.entry]); setQuestion('') }
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  async function openAsk() {
    if (panel === 'ask') { setPanel(null); return }
    setPanel('ask'); setError('')
    if (entries) return
    try {
      const list = await client.getPracticeExplanations(card.id)
      const saved = Array.isArray(list) ? list : []
      setEntries(saved)
      if (!saved.length) ask('')
    } catch (err) {
      setError(messageFor(err))
    }
  }

  return (
    <View style={styles.extras}>
      {!!note && panel !== 'note' && (
        <View style={styles.noteBox}>
          <Text style={styles.noteLabel}>Your note</Text>
          <Text style={styles.noteText}>{note}</Text>
        </View>
      )}
      <View style={styles.extrasRow}>
        {client?.canAsk && (
          <TouchableOpacity style={[styles.extraButton, panel === 'ask' && styles.extraButtonOn]} onPress={openAsk} accessibilityRole="button"
            accessibilityLabel={card.explained ? 'Ask AI, has a saved answer' : 'Ask AI about this question'}>
            <Text style={[styles.extraText, panel === 'ask' && styles.extraTextOn]}>✦ Ask AI{card.explained && panel !== 'ask' ? ' · saved' : ''}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={[styles.extraButton, panel === 'note' && styles.extraButtonOn]} onPress={() => setPanel(p => (p === 'note' ? null : 'note'))}
          accessibilityRole="button">
          <Text style={[styles.extraText, panel === 'note' && styles.extraTextOn]}>✎ {note ? 'Edit note' : 'Add note'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.extraButton} onPress={onReport} accessibilityRole="button" accessibilityLabel="Report outdated or wrong">
          <Text style={styles.extraText}>⚑ Report</Text>
        </TouchableOpacity>
      </View>
      {!!error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}

      {panel === 'note' && (
        <View style={styles.panel}>
          <TextInput value={draft} onChangeText={setDraft} multiline maxLength={5000} autoFocus
            placeholder="Your own words, an example from a project…" placeholderTextColor={colors.textFaint}
            style={styles.noteInput} accessibilityLabel="Your note" />
          <View style={styles.panelRow}>
            <TouchableOpacity style={[styles.smallButton, styles.buttonPrimary]} onPress={saveNote} disabled={busy} accessibilityRole="button">
              <Text style={styles.buttonPrimaryText}>Save note</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.smallButton} onPress={() => { setDraft(note); setPanel(null) }} accessibilityRole="button">
              <Text style={styles.extraText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {panel === 'ask' && (
        <View style={styles.panel}>
          {entries?.map(e => (
            <View key={e.id} style={{ marginBottom: 10 }}>
              {!!e.prompt && <Text style={styles.asked}>You asked: {e.prompt}</Text>}
              <Blocks blocks={e.blocks} styles={styles} />
            </View>
          ))}
          {busy && <ActivityIndicator style={{ marginVertical: 8 }} color={colors.textMuted} />}
          <View style={styles.panelRow}>
            <TextInput value={question} onChangeText={setQuestion} maxLength={1000} placeholder="Ask a follow-up…"
              placeholderTextColor={colors.textFaint} style={styles.askInput} accessibilityLabel="Ask a follow-up question"
              returnKeyType="send" onSubmitEditing={() => question.trim() && ask(question)} />
            <TouchableOpacity style={[styles.smallButton, styles.buttonPrimary]} disabled={busy || !question.trim()} onPress={() => ask(question)} accessibilityRole="button">
              <Text style={styles.buttonPrimaryText}>Ask</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>Uses the desktop&apos;s AI provider. Answers are saved with the card.</Text>
        </View>
      )}
    </View>
  )
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
      if (err.practiceUnavailable) setUnavailable(err.message)
      else if (Number(err.status) === 404) setUnavailable('Update Hiro on the desktop to practise from your phone.')
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
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textMuted} />}>
      <Text style={styles.title} accessibilityRole="header">Practice</Text>
      {!!data?.stats && <Text style={styles.muted}>{statsLine(data.stats)}</Text>}
      {!!data?.cloud && (
        <Text style={[styles.muted, { marginTop: 4 }]} accessibilityRole="text">
          Through the cloud · cards from {data.day}
          {data.pendingChanges ? ` · ${data.pendingChanges} change${data.pendingChanges === 1 ? '' : 's'} reach the desktop when it next syncs` : ''}
        </Text>
      )}
      {(data?.countdown || []).filter(c => c.cards > 0).map(c => (
        <View key={c.applicationId} style={styles.countdown} accessibilityRole="text">
          <Text style={styles.countdownDays}>{c.daysLeft === 0 ? 'Today' : c.daysLeft === 1 ? '1 day' : `${c.daysLeft} days`}</Text>
          <Text style={styles.countdownText}>
            {c.company || 'Interview'} interview {c.daysLeft === 0 ? 'today' : c.daysLeft === 1 ? 'tomorrow' : `in ${c.daysLeft} days`}
            {c.cardsLeft > 0 ? ` · ${c.cardsLeft} card${c.cardsLeft === 1 ? '' : 's'} left, first in line` : ' · done for today ✓'}
          </Text>
        </View>
      ))}
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
            <Text style={styles.topic} numberOfLines={1}>{current.deck === 'job' ? `Job: ${current.topic}` : current.deck === 'custom' ? `Deck: ${current.topic}` : current.topic}</Text>
            <Text style={styles.position}>{data.doneCount + 1} of {data.cards.length}</Text>
          </View>
          <View style={styles.tags}>
            {!!current.category && <Text style={[styles.tag, styles.tagCategory]} accessibilityLabel={`Category: ${current.category}`}>Category: {current.category}</Text>}
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
          <CardExtras client={client} card={current} styles={styles} colors={colors} onReport={report} />
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

  tagCategory: { color: c.text, borderColor: c.borderStrong },
  countdown: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border },
  countdownDays: { color: '#fff', backgroundColor: c.accent, fontWeight: '700', fontSize: 12, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, overflow: 'hidden' },
  countdownText: { color: c.text, fontSize: 13, flex: 1 },
  extras: { marginTop: 14 },
  extrasRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  extraButton: { borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, minHeight: 36, justifyContent: 'center' },
  extraButtonOn: { backgroundColor: c.accent, borderColor: c.accent },
  extraText: { color: c.text, fontSize: 13 },
  extraTextOn: { color: '#fff', fontWeight: '600' },
  noteBox: { backgroundColor: c.surface2, borderRadius: 10, padding: 10, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: c.accent },
  noteLabel: { color: c.textMuted, fontSize: 11.5, fontWeight: '600', marginBottom: 2 },
  noteText: { color: c.text, fontSize: 14, lineHeight: 20 },
  panel: { marginTop: 10, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 },
  panelRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 },
  noteInput: { minHeight: 90, color: c.text, fontSize: 14, textAlignVertical: 'top', borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, backgroundColor: c.surface },
  askInput: { flex: 1, color: c.text, fontSize: 14, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: c.surface, minHeight: 40 },
  smallButton: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9, minHeight: 40, justifyContent: 'center', borderWidth: 1, borderColor: c.border },
  asked: { color: c.textMuted, fontSize: 12.5, marginBottom: 4 },
  hint: { color: c.textFaint, fontSize: 11.5, marginTop: 6 },
  reportLink: { marginTop: 14, alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  reportText: { color: c.textMuted, fontSize: 12.5, textDecorationLine: 'underline' },
})
