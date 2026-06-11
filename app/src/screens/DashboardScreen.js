import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, RefreshControl, StyleSheet } from 'react-native'
import { colors, radius, statusColors } from '../theme'

export default function DashboardScreen({ client }) {
  const [stats, setStats] = useState(null)
  const [perDay, setPerDay] = useState([])
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, pd] = await Promise.all([client.getStats(), client.getPerDay(7)])
      setStats(s)
      setPerDay(pd)
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [client])

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
