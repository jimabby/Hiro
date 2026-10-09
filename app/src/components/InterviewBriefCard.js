import { useState, useMemo } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Linking } from 'react-native'
import { radius, useTheme } from '../theme'
import { parseLocal, formatDay, clockTime } from '../dates'

// scheduled_at is the desktop's wall-clock time with no zone, so it is read as
// local — never through the UTC parser the timestamps elsewhere use.
function formatInterview(iv) {
  const d = parseLocal(iv.scheduledAt)
  if (!d) return iv.scheduledAt
  return iv.hasTime ? `${formatDay(iv.scheduledAt)}, ${clockTime(d)}` : formatDay(iv.scheduledAt)
}

// The night-before interview brief, as the desktop prepared it: when, what is
// in the news, the likely questions with your answers, and what to ask them.
// Read-only and never generated from here — opening it costs nothing.

export default function InterviewBriefCard({ client, applicationId }) {
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [brief, setBrief] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [openQ, setOpenQ] = useState(null)

  async function load() {
    setLoading(true); setError('')
    try { setBrief(await client.getInterviewBrief(applicationId)) } catch (err) { setError(err.message) } finally { setLoading(false) }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">Interview brief</Text>
      {!brief && (
        <TouchableOpacity style={styles.btn} onPress={load} disabled={loading} accessibilityRole="button"
          accessibilityLabel="Show the interview brief">
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Show brief</Text>}
        </TouchableOpacity>
      )}
      {!!error && <Text style={styles.error}>{error}</Text>}
      {brief && (
        <>
          <Text style={styles.label}>When</Text>
          <Text style={styles.body}>{brief.interview ? formatInterview(brief.interview) : 'No time recorded yet.'}</Text>

          {!!brief.notes && (<><Text style={styles.label}>Your notes</Text><Text style={styles.body}>{brief.notes}</Text></>)}

          {brief.replies?.length > 0 && (
            <>
              <Text style={styles.label}>What they said</Text>
              {brief.replies.map((r, i) => <Text key={i} style={styles.muted}>{r.subject}: {r.excerpt}</Text>)}
            </>
          )}

          {(brief.research?.summary || brief.research?.headlines?.length > 0) && (
            <>
              <Text style={styles.label}>In the news</Text>
              {!!brief.research.summary && <Text style={styles.body}>{brief.research.summary}</Text>}
              {(brief.research.headlines || []).slice(0, 4).map((h, i) => (
                <Text key={i} style={styles.link} onPress={() => h.url && Linking.openURL(h.url)} accessibilityRole="link">
                  {h.title} — {h.source || ''} {h.date}
                </Text>
              ))}
            </>
          )}

          <Text style={styles.label}>Likely questions{brief.answered ? ` — ${brief.answered} answered` : ''}</Text>
          {brief.questions?.length ? brief.questions.map((q, i) => (
            <TouchableOpacity key={i} onPress={() => setOpenQ(openQ === i ? null : i)} accessibilityRole="button"
              accessibilityState={{ expanded: openQ === i }}>
              <Text style={styles.body}>{openQ === i ? '▾' : '▸'} {q.question}</Text>
              {openQ === i && <Text style={[styles.muted, { marginLeft: 14 }]}>{q.savedAnswer || `Draft: ${q.sampleAnswer || '—'}`}</Text>}
            </TouchableOpacity>
          )) : <Text style={styles.muted}>Prepared on the desktop the evening before.</Text>}

          <Text style={styles.label}>Questions to ask them</Text>
          {(brief.questionsToAsk || []).map((q, i) => <Text key={i} style={styles.body}>• {q}</Text>)}
        </>
      )}
    </View>
  )
}

const makeStyles = (c) => StyleSheet.create({
  card: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius, padding: 14, marginBottom: 12 },
  title: { fontSize: 14, fontWeight: '600', color: c.text, marginBottom: 6 },
  label: { fontSize: 12, fontWeight: '700', color: c.textMuted, marginTop: 12, marginBottom: 4, textTransform: 'uppercase' },
  body: { fontSize: 13, color: c.text, lineHeight: 19, marginBottom: 3 },
  muted: { fontSize: 12, color: c.textMuted, lineHeight: 17, marginBottom: 4 },
  link: { fontSize: 12, color: c.accent, lineHeight: 17, marginBottom: 4 },
  error: { color: c.red, fontSize: 12, marginTop: 6 },
  btn: { backgroundColor: c.accent, borderRadius: radius, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#fff', fontWeight: '600' },
})
