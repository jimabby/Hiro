import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, RefreshControl, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native'
import { colors, radius, statusColors } from '../theme'
import { enqueue, flush, getPending } from '../scanQueue'

export default function DashboardScreen({ client }) {
  const [stats, setStats] = useState(null)
  const [perDay, setPerDay] = useState([])
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const [keywords, setKeywords] = useState('')
  const [scanStatus, setScanStatus] = useState(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [pendingCount, setPendingCount] = useState(0)

  const load = useCallback(async () => {
    try {
      const [s, pd] = await Promise.all([client.getStats(), client.getPerDay(7)])
      setStats(s)
      setPerDay(pd)
      setError('')
      if (client.canScan) {
        // Desktop is reachable — deliver any scans queued while it was offline.
        await flush(client)
        try { setScanStatus(await client.getScanStatus()) } catch {}
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
      setScanStatus(info)
      setScanMsg(info.running ? 'A scan is already running on the desktop — queued next.' : 'Scan queued — running on the desktop now.')
    } catch {
      await enqueue(req)
      setPendingCount((await getPending()).length)
      setScanMsg('Desktop offline — saved. It will run when the desktop is turned on.')
    } finally {
      setScanBusy(false)
    }
  }

  useEffect(() => { load() }, [load])

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
        {pendingCount > 0 && <Text style={styles.pending}>{pendingCount} scan{pendingCount > 1 ? 's' : ''} waiting to send to the desktop</Text>}
        {!!scanMsg && <Text style={styles.scanMsg}>{scanMsg}</Text>}
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
            <StatCard label="Needs Attention" value={stats.attentionCount} accent={stats.attentionCount > 0 ? colors.yellow : undefined} />
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
  pending: { color: colors.yellow, fontSize: 12, marginTop: 10 },
  scanMsg: { color: colors.textMuted, fontSize: 12, marginTop: 8 },
  chart: { gap: 8 },
  chartRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chartLabel: { width: 42, fontSize: 11, color: colors.textMuted },
  chartTrack: { flex: 1, height: 14, backgroundColor: colors.surface2, borderRadius: 7, overflow: 'hidden' },
  chartBar: { height: '100%', backgroundColor: colors.accent, borderRadius: 7 },
  chartValue: { width: 24, fontSize: 11, color: colors.text, textAlign: 'right' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowLabel: { flex: 1, color: colors.text, fontSize: 13, textTransform: 'capitalize' },
  rowValue: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
})
