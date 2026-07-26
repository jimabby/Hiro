import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  Linking, StyleSheet,
} from 'react-native'
import { colors, radius, statusColors, statusLabel } from '../theme'

const STATUSES = ['applied', 'interview', 'offer', 'rejected', 'pending', 'no_response', 'skipped']

export default function ApplicationDetailScreen({ client, id, onBack }) {
  const [app, setApp] = useState(null)
  const [error, setError] = useState('')
  const [comment, setComment] = useState('')
  const [savingComment, setSavingComment] = useState(false)
  const [savedComment, setSavedComment] = useState(false)

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
      <TouchableOpacity onPress={onBack}>
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

          {app.match_score != null && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Match: {app.match_score}%</Text>
              {!!app.match_explanation && <Text style={styles.body}>{app.match_explanation}</Text>}
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Status</Text>
            <View style={styles.statusRow}>
              {STATUSES.map(s => {
                const active = app.status === s
                const c = statusColors[s] || colors.textMuted
                return (
                  <TouchableOpacity
                    key={s}
                    style={[styles.statusChip, { borderColor: active ? c : colors.border, backgroundColor: active ? c + '26' : 'transparent' }]}
                    onPress={() => setStatus(s)}
                  >
                    <Text style={[styles.statusChipText, { color: active ? c : colors.textMuted }]}>{statusLabel(s)}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>

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
            <TouchableOpacity style={styles.saveBtn} onPress={saveComment} disabled={savingComment}>
              <Text style={styles.saveBtnText}>
                {savingComment ? 'Saving…' : savedComment ? '✓ Saved' : 'Save Note'}
              </Text>
            </TouchableOpacity>
          </View>

          {!!app.job_url && (
            <TouchableOpacity style={styles.card} onPress={() => Linking.openURL(app.job_url)}>
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  back: { color: colors.accent, fontSize: 15, marginBottom: 14 },
  error: { color: colors.red, fontSize: 13, marginBottom: 10 },
  muted: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  company: { fontSize: 14, color: colors.textMuted, marginTop: 4 },
  card: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius, padding: 14, marginTop: 12,
  },
  cardTitle: { fontSize: 14, fontWeight: '600', color: colors.text, marginBottom: 6 },
  body: { fontSize: 13, color: colors.text, lineHeight: 19 },
  question: { fontSize: 13, color: colors.textMuted, fontWeight: '600', marginBottom: 2 },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  statusChip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  statusChipText: { fontSize: 12, textTransform: 'capitalize', fontWeight: '600' },
  commentInput: {
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius, padding: 10, color: colors.text, fontSize: 13,
    minHeight: 70, textAlignVertical: 'top',
  },
  saveBtn: {
    backgroundColor: colors.accent, borderRadius: radius,
    paddingVertical: 9, alignItems: 'center', marginTop: 10,
  },
  saveBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
})
