// "What do I do today": overdue, due today, and the next few days, across
// follow-ups, checklist items, interviews, offer deadlines and closing dates.
// Opened from the Dashboard. The rules are in src/todayTasks.js and where the
// data comes from in src/todayLoader.js; this file only draws them.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
import { radius, useTheme } from '../theme'
import { loadTodayTasks } from '../todayLoader'
import { todayView, SOON_DAYS } from '../todayTasks'
import { todayLocal, describeDue, formatDay } from '../dates'
import { classifyError, messageFor } from '../requestErrors'

const KIND_LABEL = {
  interview: 'Interview', offer: 'Offer', closing: 'Closes', attention: 'Closes',
  'follow-up': 'Follow-up', checklist: 'Task', 'checklist-error': 'Task', 'propose-times': 'Reply',
}

export default function TodayScreen({ client, onBack, onOpenApplication, onNeedsPairing }) {
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  // Only the newest load may draw, so a slow first load cannot overwrite a
  // pull-to-refresh that finished before it.
  const seq = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++seq.current
    try {
      const res = await loadTodayTasks(client)
      if (ticket !== seq.current) return
      setResult({ ...res, today: todayLocal() })
      setError('')
    } catch (err) {
      if (ticket !== seq.current) return
      setError(messageFor(err))
      if (classifyError(err) === 'auth') onNeedsPairing?.()
    }
  }, [client, onNeedsPairing])

  useEffect(() => { load() }, [load])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  const view = useMemo(() => (result ? todayView(result.tasks, result.today) : null), [result])
  const empty = view && !view.overdue.length && !view.today.length && !view.soon.length

  const dueText = (task) => {
    if (task.kind === 'interview') {
      const when = describeDue(task.due, result.today).replace(/^due /, '')
      return task.time ? `${when} · ${task.time}` : when
    }
    return describeDue(task.due, result.today)
  }

  const renderTask = (task, tone) => {
    const canOpen = task.applicationId != null && !!onOpenApplication
    return (
      <TouchableOpacity key={task.id} style={styles.row} disabled={!canOpen}
        onPress={() => onOpenApplication?.(task.applicationId)}
        accessibilityRole={canOpen ? 'button' : undefined}
        accessibilityLabel={`${KIND_LABEL[task.kind] || 'Task'}: ${task.title}. ${task.jobTitle || ''}${task.company ? ` at ${task.company}` : ''}, ${dueText(task)}`}
        accessibilityHint={canOpen ? 'Opens the application' : undefined}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle} numberOfLines={2}>
            <Text style={[styles.kind, { color: tone }]}>{KIND_LABEL[task.kind] || 'Task'} · </Text>
            {task.title}
          </Text>
          {!!(task.jobTitle || task.company) && (
            <Text style={styles.muted} numberOfLines={1}>{[task.jobTitle, task.company].filter(Boolean).join(' · ')}</Text>
          )}
        </View>
        <Text style={[styles.due, { color: tone }]}>{dueText(task)}</Text>
        {canOpen && <Text style={styles.chevron} importantForAccessibility="no">›</Text>}
      </TouchableOpacity>
    )
  }

  const section = (title, tasks, tone) => tasks.length > 0 && (
    <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: tone }]}>
      <Text style={styles.cardTitle} accessibilityRole="header">{title} ({tasks.length})</Text>
      {tasks.map(t => renderTask(t, tone))}
    </View>
  )

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}>
      <TouchableOpacity onPress={onBack} style={styles.back} accessibilityRole="button" accessibilityLabel="Back to the dashboard">
        <Text style={styles.backText}>‹ Dashboard</Text>
      </TouchableOpacity>
      <Text style={styles.title} accessibilityRole="header">Today</Text>
      {!!result && <Text style={styles.subtitle}>{formatDay(result.today)}</Text>}

      {!!error && <Text style={styles.error}>{error}</Text>}
      {!result && !error && <ActivityIndicator style={{ marginVertical: 24 }} color={colors.accent} />}

      {view && (
        <>
          {section('Overdue', view.overdue, colors.red)}
          {section('Today', view.today, colors.accent)}
          {section(`Next ${SOON_DAYS} days`, view.soon, colors.textMuted)}
          {empty && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Nothing due</Text>
              <Text style={styles.muted}>
                No follow-ups, tasks, interviews or deadlines in the next {SOON_DAYS} days. Pull down to refresh.
              </Text>
            </View>
          )}
          {result.truncated && (
            <Text style={styles.note}>
              Checklists were read for your most recent applications only. Update the desktop app to see every task here.
            </Text>
          )}
          <Text style={styles.note}>Tasks without a due date are on the desktop’s task inbox.</Text>
        </>
      )}
    </ScrollView>
  )
}

// Rebuilt per palette — see useTheme() in ../theme.
const makeStyles = (c) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  back: { alignSelf: 'flex-start', paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  backText: { color: c.accent, fontSize: 15, fontWeight: '600' },
  title: { fontSize: 22, fontWeight: '700', color: c.text },
  subtitle: { color: c.textMuted, fontSize: 13, marginTop: 2, marginBottom: 6 },
  error: { color: c.red, fontSize: 13, marginVertical: 12 },
  card: {
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
    borderRadius: radius, padding: 16, marginTop: 10,
  },
  cardTitle: { fontSize: 14, fontWeight: '600', color: c.text, marginBottom: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
  },
  rowTitle: { color: c.text, fontSize: 13, fontWeight: '600' },
  kind: { fontWeight: '700' },
  muted: { color: c.textMuted, fontSize: 13, marginTop: 2 },
  due: { fontSize: 12, fontWeight: '700', maxWidth: 120, textAlign: 'right' },
  chevron: { color: c.textFaint, fontSize: 20, marginLeft: -2 },
  note: { color: c.textMuted, fontSize: 12, marginTop: 14, lineHeight: 17 },
})
