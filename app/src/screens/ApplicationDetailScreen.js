import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  Linking, StyleSheet,
} from 'react-native'
import { radius, statusLabel, SETTABLE_STATUSES, useTheme, useStatusColors } from '../theme'
import NextAction from '../components/NextAction'

// Rows that were never submitted have nothing to chase — there is no recruiter on
// the other end of a held draft. Mirrors UNSENT_STATUSES on the desktop.
const UNSENT = ['skipped', 'held']

export default function ApplicationDetailScreen({ client, id, onBack }) {
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
      setError('')
    } catch (err) {
      setError(/404/.test(err.message) ? 'Application not found on the desktop.' : err.message)
    }
  }, [client, id])

  useEffect(() => { load() }, [load])

  async function setStatus(status) {
    try {
      await client.updateStatus(id, status)
      setApp(a => ({ ...a, status }))
    } catch (err) {
      setError(err.message)
    }
  }

  async function saveComment() {
    setSavingComment(true)
    try {
      await client.updateComment(id, comment)
      setSavedComment(true)
      setTimeout(() => setSavedComment(false), 2500)
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingComment(false)
    }
  }

  let screeningQa = []
  try { screeningQa = JSON.parse(app?.screening_qa || '[]') } catch { /* legacy rows */ }

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <TouchableOpacity onPress={onBack}
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
          <Text style={styles.muted}>Applied {(app.applied_at || '').slice(0, 16)}</Text>

          {app.status === 'held' && client.requestReviewAction && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Waiting for review</Text>
              <Text style={styles.body}>Queue a decision for the desktop. Approval submits only when its browser session is available.</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <TouchableOpacity style={styles.saveBtn}
                  accessibilityRole="button" accessibilityLabel="Approve this draft on the desktop"
                  accessibilityHint="Queues the approval; the desktop submits it when its browser session is available"
                  onPress={async () => { await client.requestReviewAction(id, 'approve'); setReviewQueued('Approval queued') }}><Text style={styles.saveBtnText}>Approve on desktop</Text></TouchableOpacity>
                <TouchableOpacity style={[styles.saveBtn, { backgroundColor: colors.red }]}
                  accessibilityRole="button" accessibilityLabel="Reject this draft"
                  accessibilityHint="Nothing is sent and the job is filed as skipped"
                  onPress={async () => { await client.requestReviewAction(id, 'reject'); setReviewQueued('Rejection queued') }}><Text style={styles.saveBtnText}>Reject</Text></TouchableOpacity>
              </View>
              {!!reviewQueued && <Text style={[styles.muted, { marginTop: 8 }]}>{reviewQueued}</Text>}
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
                setApp(a => ({ ...a, next_action_at: date, next_action_note: note }))
              }}
              onComplete={async () => {
                await client.completeNextAction(id)
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
            <TouchableOpacity style={styles.saveBtn} onPress={saveComment} disabled={savingComment}
              accessibilityRole="button" accessibilityLabel="Save note"
              accessibilityState={{ disabled: savingComment, busy: savingComment }}>
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
  )
}

// Rebuilt per palette — see useTheme() in ../theme.
const makeStyles = (c) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  back: { color: c.accent, fontSize: 15, marginBottom: 14 },
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
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  statusChip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  statusChipText: { fontSize: 12, textTransform: 'capitalize', fontWeight: '600' },
  commentInput: {
    backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border,
    borderRadius: radius, padding: 10, color: c.text, fontSize: 13,
    minHeight: 70, textAlignVertical: 'top',
  },
  saveBtn: {
    backgroundColor: c.accent, borderRadius: radius,
    paddingVertical: 9, alignItems: 'center', marginTop: 10,
  },
  saveBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
})
