import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, RefreshControl, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Linking, Platform } from 'react-native'
import { colors, radius, statusColors } from '../theme'
import { enqueue, flush, getPending } from '../scanQueue'

export default function DashboardScreen({ client }) {
  const [stats, setStats] = useState(null)
  const [perDay, setPerDay] = useState([])
  const [attention, setAttention] = useState([])
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const [keywords, setKeywords] = useState('')
  const [scanStatus, setScanStatus] = useState(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [pendingCount, setPendingCount] = useState(0)
  const [liveLog, setLiveLog] = useState([])
  const [cancelBusy, setCancelBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, pd] = await Promise.all([client.getStats(), client.getPerDay(7)])
      setStats(s)
      setPerDay(pd)
      setError('')
      if (client.canScan) {
        // Desktop is reachable — deliver any scans queued while it was offline.
        await flush(client)
        // Clear on failure rather than keep displaying stale running/queued info.
        try { setScanStatus(await client.getScanStatus()) } catch { setScanStatus(null) }
        try { setAttention(await client.getAttention()) } catch { setAttention([]) }
        setPendingCount((await getPending()).length)
      }
    } catch (err) {
      setError(err.message)
    }
  }, [client])

  async function onRunScan() {
    setScanBusy(true)
    setScanMsg('')
    const req = { keywords: keywords.trim(), location: '', createdAt: new Date().toISOString() }
    try {
      const info = await client.requestScan({ keywords: req.keywords })
      if (info.cloud) {
        // Queued via Supabase — the desktop drains requests on its next sync.
        setScanMsg('Scan queued via the cloud — the desktop will pick it up within a couple of minutes.')
        // Refresh the status so the queued count shows and live polling starts.
        try { setScanStatus(await client.getScanStatus()) } catch { /* status is decorative */ }
      } else {
        setScanStatus(info)
        setScanMsg(info.running ? 'A scan is already running on the desktop — queued next.' : 'Scan queued — running on the desktop now.')
      }
    } catch {
      await enqueue(req)
      setPendingCount((await getPending()).length)
      setScanMsg('Desktop offline — saved. It will run when the desktop is turned on.')
    } finally {
      setScanBusy(false)
    }
  }

  useEffect(() => { load() }, [load])

  // Live scan progress: while the desktop is scanning (or scans are queued),
  // poll the status — and over LAN also the activity log, so the user can
  // watch the scan work ("Found 14 jobs on Seek… applying…") in real time.
  // Cloud mode polls status only, at a gentler rate (each tick is a Supabase
  // read); LAN talks straight to the desktop so 4s is cheap.
  const scanActive = !!(scanStatus?.running || scanStatus?.queued > 0)
  useEffect(() => {
    if (!scanActive) return
    let cancelled = false
    let finishing = false
    const tick = async () => {
      try {
        const [status, logs] = await Promise.all([
          client.getScanStatus(),
          client.getLogs ? client.getLogs(40) : Promise.resolve(null),
        ])
        if (cancelled) return
        if (logs?.lines) setLiveLog(logs.lines)
        setScanStatus(status)
        // Scan finished — refresh stats/chart once so new applications show up.
        if (status && !status.running && !(status.queued > 0) && !finishing) {
          finishing = true
          load()
        }
      } catch { /* desktop went away mid-scan; pull-to-refresh recovers */ }
    }
    const id = setInterval(tick, client.getLogs ? 4000 : 10000)
    tick()
    return () => { cancelled = true; clearInterval(id) }
  }, [scanActive, client, load])

  async function onCancelScan() {
    setCancelBusy(true)
    try {
      const info = await client.cancelScan()
      setScanStatus(info)
      setScanMsg('Scan cancelled.')
    } catch (err) {
      setScanMsg(err.message)
    } finally {
      setCancelBusy(false)
    }
  }

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const maxPerDay = Math.max(1, ...perDay.map(d => d.count))

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
    >
      <Text style={styles.title}>Dashboard</Text>
      {!!error && <Text style={styles.error}>{error}</Text>}

      {/* Trigger a scan on the desktop (LAN connection only) */}
      {client.canScan && (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Run a scan</Text>
        {scanStatus && (
          <Text style={styles.muted}>
            Desktop: {scanStatus.running ? 'scanning now…' : 'idle'}
            {scanStatus.queued > 0 ? ` · ${scanStatus.queued} queued` : ''}
            {scanStatus.lastScanAt ? ` · last ${new Date(scanStatus.lastScanAt).toLocaleString()}` : ''}
          </Text>
        )}
        <TextInput
          style={styles.input}
          placeholder="Keywords (optional — blank uses desktop settings)"
          placeholderTextColor={colors.textMuted}
          value={keywords}
          onChangeText={setKeywords}
          autoCapitalize="none"
        />
        <TouchableOpacity style={[styles.scanBtn, scanBusy && { opacity: 0.6 }]} onPress={onRunScan} disabled={scanBusy}>
          {scanBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.scanBtnText}>Run scan now</Text>}
        </TouchableOpacity>
        {scanStatus?.running && !!client.cancelScan && (
          <TouchableOpacity style={[styles.cancelBtn, cancelBusy && { opacity: 0.6 }]} onPress={onCancelScan} disabled={cancelBusy}>
            <Text style={styles.cancelBtnText}>{cancelBusy ? 'Cancelling…' : 'Cancel scan'}</Text>
          </TouchableOpacity>
        )}
        {pendingCount > 0 && <Text style={styles.pending}>{pendingCount} scan{pendingCount > 1 ? 's' : ''} waiting to send to the desktop</Text>}
        {!!scanMsg && <Text style={styles.scanMsg}>{scanMsg}</Text>}

        {/* Live activity feed while a scan runs (LAN only — the log stays on
            the desktop; cloud mode shows the status line above instead) */}
        {scanActive && !!client.getLogs && liveLog.length > 0 && (
          <View style={styles.liveLog}>
            {liveLog.slice(-8).map((line, i) => (
              <Text key={i} style={styles.liveLogLine} numberOfLines={2}>
                {line.replace(/^\[\d{4}-\d{2}-\d{2} (\d{2}:\d{2}):\d{2}\]/, '[$1]')}
              </Text>
            ))}
          </View>
        )}
      </View>
      )}

      {stats && (
        <>
          <View style={styles.statRow}>
            <StatCard label="Today" value={stats.totalToday} />
            <StatCard label="This Week" value={stats.totalThisWeek} />
          </View>
          <View style={styles.statRow}>
            <StatCard label="All Time" value={stats.totalAllTime} />
            <StatCard label="Interviews" value={stats.interviews} accent={colors.green} />
          </View>
          <View style={styles.statRow}>
            <StatCard label="Response Rate" value={`${stats.responseRate}%`} />
            {/* Attention jobs don't sync to the cloud (attentionCount: null) —
                hide the tile there instead of showing a misleading 0. */}
            {stats.attentionCount != null && (
              <StatCard label="Needs Attention" value={stats.attentionCount} accent={stats.attentionCount > 0 ? colors.yellow : undefined} />
            )}
          </View>

          {/* Last 7 days bar chart */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Last 7 days</Text>
            <View style={styles.chart}>
              {perDay.length === 0 && <Text style={styles.muted}>No applications yet</Text>}
              {perDay.map(d => (
                <View key={d.date} style={styles.chartRow}>
                  <Text style={styles.chartLabel}>{d.date.slice(5)}</Text>
                  <View style={styles.chartTrack}>
                    <View style={[styles.chartBar, { width: `${(d.count / maxPerDay) * 100}%` }]} />
                  </View>
                  <Text style={styles.chartValue}>{d.count}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* Jobs flagged for manual application (LAN only — these don't sync) */}
          {client.canScan && attention.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Needs attention ({attention.length})</Text>
              {attention.slice(0, 5).map(job => (
                <TouchableOpacity
                  key={job.id}
                  style={styles.attentionRow}
                  disabled={!job.job_url}
                  onPress={() => job.job_url && Linking.openURL(job.job_url)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.attentionTitle} numberOfLines={1}>{job.job_title}</Text>
                    <Text style={styles.muted} numberOfLines={1}>
                      {job.company}{job.reason ? ` · ${job.reason}` : ''}
                    </Text>
                  </View>
                  {job.match_score != null && <Text style={styles.attentionScore}>{job.match_score}%</Text>}
                </TouchableOpacity>
              ))}
              {attention.length > 5 && (
                <Text style={[styles.muted, { marginTop: 6 }]}>+{attention.length - 5} more on the desktop</Text>
              )}
            </View>
          )}

          {/* By status */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>By status</Text>
            {(stats.byStatus || []).map(s => (
              <View key={s.status} style={styles.row}>
                <View style={[styles.dot, { backgroundColor: statusColors[s.status] || colors.textMuted }]} />
                <Text style={styles.rowLabel}>{s.status}</Text>
                <Text style={styles.rowValue}>{s.count}</Text>
              </View>
            ))}
          </View>

          {/* By platform */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>By platform</Text>
            {(stats.byPlatform || []).map(p => (
              <View key={p.platform} style={styles.row}>
                <Text style={styles.rowLabel}>{p.platform}</Text>
                <Text style={styles.rowValue}>{p.count}</Text>
              </View>
            ))}
          </View>
        </>
      )}
    </ScrollView>
  )
}

function StatCard({ label, value, accent }) {
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, accent ? { color: accent } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  title: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: 16 },
  error: { color: colors.red, fontSize: 13, marginBottom: 12 },
  statRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  statCard: {
    flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius, padding: 16, alignItems: 'center',
  },
  statValue: { fontSize: 26, fontWeight: '700', color: colors.text },
  statLabel: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  card: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius, padding: 16, marginTop: 10,
  },
  cardTitle: { fontSize: 14, fontWeight: '600', color: colors.text, marginBottom: 12 },
  muted: { color: colors.textMuted, fontSize: 13 },
  input: {
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radius,
    color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginTop: 10,
  },
  scanBtn: {
    backgroundColor: colors.accent, borderRadius: radius, paddingVertical: 12,
    alignItems: 'center', marginTop: 10,
  },
  scanBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  cancelBtn: {
    borderWidth: 1, borderColor: colors.red, borderRadius: radius,
    paddingVertical: 10, alignItems: 'center', marginTop: 8,
  },
  cancelBtnText: { color: colors.red, fontSize: 13, fontWeight: '600' },
  liveLog: {
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius, padding: 10, marginTop: 10, gap: 3,
  },
  liveLogLine: {
    color: colors.textMuted, fontSize: 11, lineHeight: 15,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  pending: { color: colors.yellow, fontSize: 12, marginTop: 10 },
  scanMsg: { color: colors.textMuted, fontSize: 12, marginTop: 8 },
  chart: { gap: 8 },
  chartRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chartLabel: { width: 42, fontSize: 11, color: colors.textMuted },
  chartTrack: { flex: 1, height: 14, backgroundColor: colors.surface2, borderRadius: 7, overflow: 'hidden' },
  chartBar: { height: '100%', backgroundColor: colors.accent, borderRadius: 7 },
  chartValue: { width: 24, fontSize: 11, color: colors.text, textAlign: 'right' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
  attentionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  attentionTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
  attentionScore: { color: colors.yellow, fontSize: 13, fontWeight: '700' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowLabel: { flex: 1, color: colors.text, fontSize: 13, textTransform: 'capitalize' },
  rowValue: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
})
