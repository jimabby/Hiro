import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  Linking, StyleSheet, KeyboardAvoidingView, Platform, Alert, RefreshControl, BackHandler,
} from 'react-native'
import { radius, statusLabel, SETTABLE_STATUSES, useTheme, useStatusColors } from '../theme'
import NextAction from '../components/NextAction'
import { formatFull } from '../dates'
import { selection, success, failure } from '../haptics'

// Rows that were never submitted have nothing to chase — there is no recruiter on
// the other end of a held draft. Mirrors UNSENT_STATUSES on the desktop.
const UNSENT = ['skipped', 'held']

export default function ApplicationDetailScreen({ client, id, onBack, active = true, onChanged }) {
  // Palette and stylesheet follow the phone's appearance setting. Named
  // `colors` so every inline reference below reads unchanged.
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const statusColors = useStatusColors()

  const [app, setApp] = useState(null)
  const [error, setError] = useState('')
  const [comment, setComment] = useState('')
  const [savingComment, setSavingComment] = useState(false)
  const [savedComment, setSavedComment] = useState(false)
  const [reviewQueued, setReviewQueued] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // The note as last saved, so the button can say whether there is anything to
  // save and leaving with an edit in flight can be caught.
  const [savedText, setSavedText] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await client.getApplication(id)
      if (!data) {
        // Cloud path returns null when the row hasn't synced yet (LAN throws 404).
        setError("This application hasn't synced yet — pull to refresh in a moment.")
        return
      }
      setApp(data)
      setComment(data.comment || '')
      setSavedText(data.comment || '')
      setError('')
    } catch (err) {
      setError(/404/.test(err.message) ? 'Application not found on the desktop.' : err.message)
    }
  }, [client, id])

  useEffect(() => { load() }, [load])

  async function setStatus(status) {
    if (status === app?.status) return
    const previous = app?.status
    // Optimistic, because a chip that waits a network round trip before lighting
    // up reads as a missed tap and gets tapped again. Rolled back on failure.
    selection()
    setApp(a => ({ ...a, status }))
    try {
      await client.updateStatus(id, status)
      setError('')
      onChanged?.()
    } catch (err) {
      setApp(a => ({ ...a, status: previous }))
      failure()
      setError(err.message)
    }
  }

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  // Approving or rejecting a held draft. Both used to be fire-and-forget: a
  // failure (no review_requests table, offline) threw into nowhere and the
  // button looked like it had done nothing, inviting a second tap.
  async function review(action) {
    setReviewBusy(true)
    setError('')
    try {
      await client.requestReviewAction(id, action)
      success()
      onChanged?.()
      setReviewQueued(action === 'approve'
        ? 'Approval queued — the desktop submits it on its next sync.'
        : 'Rejection queued — nothing will be sent.')
    } catch (err) {
      failure()
      setError(err.message)
    } finally {
      setReviewBusy(false)
    }
  }

  function confirmReject() {
    Alert.alert(
      'Reject this draft?',
      'Nothing is sent to the employer, and the job is filed as skipped.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reject', style: 'destructive', onPress: () => review('reject') },
      ]
    )
  }

  // An unsaved note is the one thing on this screen that is lost by leaving it.
  function goBack() {
    if (comment === savedText) return onBack()
    Alert.alert('Discard your note?', 'The note has changes that have not been saved.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Save', onPress: async () => { if (await saveComment()) onBack() } },
      { text: 'Discard', style: 'destructive', onPress: onBack },
    ])
  }

  // Android back closes this page, through the same unsaved-note check as the
  // on-screen link. Newer handlers run first, so this one beats the shell's.
  // Only while this tab is on screen: tabs stay mounted, and a hidden detail
  // page must not swallow back presses meant for the tab in front of it.
  const goBackRef = useRef(goBack)
  goBackRef.current = goBack
  useEffect(() => {
    if (!active) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      goBackRef.current()
      return true
    })
    return () => sub.remove()
  }, [active])

  async function saveComment() {
    setSavingComment(true)
    try {
      await client.updateComment(id, comment)
      success()
      setSavedText(comment)
      setSavedComment(true)
      setTimeout(() => setSavedComment(false), 2500)
      return true
    } catch (err) {
      setError(err.message)
      return false
    } finally {
      setSavingComment(false)
    }
  }

  let screeningQa = []
  try { screeningQa = JSON.parse(app?.screening_qa || '[]') } catch { /* legacy rows */ }

  return (
    // The notes field sits mid-page; without this the iOS keyboard covers it
    // and the Save button under it. Android resizes the window itself.
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView
      style={styles.root}
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      // "handled" so Save works on the first tap with the keyboard up, rather
      // than the first tap only dismissing the keyboard.
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
    >
      <TouchableOpacity onPress={goBack} style={styles.backBtn}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 20 }}
        accessibilityRole="button" accessibilityLabel="Back to applications">
        <Text style={styles.back}>‹ Applications</Text>
      </TouchableOpacity>

      {!!error && <Text style={styles.error}>{error}</Text>}
      {!app && !error && <Text style={styles.muted}>Loading…</Text>}

      {app && (
        <>
          <Text style={styles.title}>{app.job_title}</Text>
          <Text style={styles.company}>{app.company} · {app.platform}</Text>
          {!!app.salary && <Text style={styles.muted}>{app.salary}</Text>}
          {!!app.applied_at && (
            <Text style={styles.muted}>
              {app.status === 'held' || app.status === 'skipped' ? 'Found' : 'Applied'} {formatFull(app.applied_at)}
            </Text>
          )}

          {/* The cloud copy could not be fully opened on this phone. Saying so
              beats a page that silently lacks its cover letter. */}
          {(!!app.documents_pending || !!app.meta_pending) && (
            <Text style={styles.pendingNote}>
              {app.documents_pending
                || 'Some details are encrypted and could not be opened on this phone. Sign in again, or view them on the desktop.'}
            </Text>
          )}

          {app.status === 'held' && client.requestReviewAction && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Waiting for review</Text>
              <Text style={styles.body}>Queue a decision for the desktop. Approval submits only when its browser session is available.</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <TouchableOpacity style={[styles.saveBtn, { flex: 1 }, (reviewBusy || !!reviewQueued) && styles.btnDisabled]}
                  disabled={reviewBusy || !!reviewQueued}
                  accessibilityRole="button" accessibilityLabel="Approve this draft on the desktop"
                  accessibilityHint="Queues the approval; the desktop submits it when its browser session is available"
                  accessibilityState={{ disabled: reviewBusy || !!reviewQueued, busy: reviewBusy }}
                  onPress={() => review('approve')}><Text style={styles.saveBtnText}>Approve</Text></TouchableOpacity>
                <TouchableOpacity style={[styles.saveBtn, { flex: 1, backgroundColor: colors.red }, (reviewBusy || !!reviewQueued) && styles.btnDisabled]}
                  disabled={reviewBusy || !!reviewQueued}
                  accessibilityRole="button" accessibilityLabel="Reject this draft"
                  accessibilityHint="Nothing is sent and the job is filed as skipped"
                  accessibilityState={{ disabled: reviewBusy || !!reviewQueued, busy: reviewBusy }}
                  onPress={confirmReject}><Text style={styles.saveBtnText}>Reject</Text></TouchableOpacity>
              </View>
              {!!reviewQueued && <Text style={[styles.muted, { marginTop: 8 }]} accessibilityLiveRegion="polite">{reviewQueued}</Text>}
            </View>
          )}

          {/* Only offered when there is genuinely something to follow up on, and
              only when this build of the desktop/schema supports it — the client
              throws a clear message rather than failing silently, but hiding the
              control entirely for unsent rows is the honest thing. */}
          {!UNSENT.includes(app.status) && client.setNextAction && (
            <NextAction
              app={app}
              onSave={async ({ date, note }) => {
                const res = await client.setNextAction(id, { date, note })
                if (res?.success === false) throw new Error(res.reason || 'Could not save.')
                success()
                onChanged?.()
                setApp(a => ({ ...a, next_action_at: date, next_action_note: note }))
              }}
              onComplete={async () => {
                await client.completeNextAction(id)
                success()
                onChanged?.()
                setApp(a => ({ ...a, next_action_at: null, next_action_note: '' }))
              }}
            />
          )}

          {app.match_score != null && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Match: {app.match_score}%</Text>
              {!!app.match_explanation && <Text style={styles.body}>{app.match_explanation}</Text>}
            </View>
          )}

          {app.status !== 'held' && <View style={styles.card}>
            <Text style={styles.cardTitle}>Status</Text>
            {/* A row whose status the scan assigned ('skipped') has no chip to
                light up, and a grid of unselected chips reads as "unset" rather
                than "not one of these". Say what it is before offering to
                change it. */}
            {!SETTABLE_STATUSES.includes(app.status) && (
              <Text style={[styles.muted, { marginBottom: 8 }]}>
                Currently {statusLabel(app.status)} — set by the scan. Choosing below overrides it.
              </Text>
            )}
            <View
              style={styles.statusRow}
              accessibilityRole="radiogroup"
              accessibilityLabel="Application status"
            >
              {SETTABLE_STATUSES.map(s => {
                const active = app.status === s
                const c = statusColors[s] || colors.textMuted
                return (
                  <TouchableOpacity
                    key={s}
                    style={[styles.statusChip, { borderColor: active ? c : colors.border, backgroundColor: active ? c + '26' : 'transparent' }]}
                    onPress={() => setStatus(s)}
                    hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active, checked: active }}
                    accessibilityLabel={statusLabel(s)}
                    accessibilityHint={active ? undefined : `Mark this application as ${statusLabel(s)}`}
                  >
                    <Text style={[styles.statusChipText, { color: active ? c : colors.textMuted }]}>{statusLabel(s)}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Notes</Text>
            <TextInput
              style={styles.commentInput}
              value={comment}
              onChangeText={setComment}
              placeholder="Add a note…"
              placeholderTextColor={colors.textMuted}
              multiline
            />
            <TouchableOpacity style={[styles.saveBtn, (savingComment || comment === savedText) && !savedComment && styles.btnDisabled]}
              onPress={saveComment} disabled={savingComment || comment === savedText}
              accessibilityRole="button" accessibilityLabel="Save note"
              accessibilityState={{ disabled: savingComment || comment === savedText, busy: savingComment }}>
              <Text style={styles.saveBtnText}>
                {savingComment ? 'Saving…' : savedComment ? '✓ Saved' : 'Save Note'}
              </Text>
            </TouchableOpacity>
          </View>

          {!!app.job_url && (
            <TouchableOpacity style={styles.card} onPress={() => Linking.openURL(app.job_url)}
              accessibilityRole="link" accessibilityLabel="Open the job posting"
              accessibilityHint="Opens in your browser">
              <Text style={[styles.cardTitle, { color: colors.accent }]}>Open job posting ↗</Text>
            </TouchableOpacity>
          )}

          {!!app.cover_letter && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Cover letter</Text>
              <Text style={styles.body}>{app.cover_letter}</Text>
            </View>
          )}

          {screeningQa.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Screening Q&A</Text>
              {screeningQa.map((qa, i) => (
                <View key={i} style={{ marginBottom: 10 }}>
                  <Text style={styles.question}>{qa.question || qa.q}</Text>
                  <Text style={styles.body}>{qa.answer || qa.a}</Text>
                </View>
              ))}
            </View>
          )}

          {!!app.job_description && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Job description</Text>
              <Text style={styles.body}>{app.job_description}</Text>
            </View>
          )}
        </>
      )}
    </ScrollView>
    </KeyboardAvoidingView>
  )
}

// Rebuilt per palette — see useTheme() in ../theme.
const makeStyles = (c) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  backBtn: { alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center', marginBottom: 8 },
  back: { color: c.accent, fontSize: 16 },
  pendingNote: { color: c.yellow, fontSize: 12, lineHeight: 17, marginTop: 8 },
  btnDisabled: { opacity: 0.5 },
  error: { color: c.red, fontSize: 13, marginBottom: 10 },
  muted: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  title: { fontSize: 20, fontWeight: '700', color: c.text },
  company: { fontSize: 14, color: c.textMuted, marginTop: 4 },
  card: {
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
    borderRadius: radius, padding: 14, marginTop: 12,
  },
  cardTitle: { fontSize: 14, fontWeight: '600', color: c.text, marginBottom: 6 },
  body: { fontSize: 13, color: c.text, lineHeight: 19 },
  question: { fontSize: 13, color: c.textMuted, fontWeight: '600', marginBottom: 2 },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statusChip: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center' },
  statusChipText: { fontSize: 13, fontWeight: '600' },
  commentInput: {
    backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border,
    borderRadius: radius, padding: 10, color: c.text, fontSize: 13,
    minHeight: 90, textAlignVertical: 'top',
  },
  saveBtn: {
    backgroundColor: c.accent, borderRadius: radius,
    paddingVertical: 12, minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: 10,
  },
  saveBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
})
