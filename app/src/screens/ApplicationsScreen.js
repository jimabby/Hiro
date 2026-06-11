import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  RefreshControl, StyleSheet,
} from 'react-native'
import { colors, radius, statusColors } from '../theme'
import ApplicationDetailScreen from './ApplicationDetailScreen'

const STATUS_FILTERS = ['all', 'applied', 'interview', 'offer', 'rejected', 'skipped']

export default function ApplicationsScreen({ client }) {
  const [apps, setApps] = useState([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [selectedId, setSelectedId] = useState(null)

  const load = useCallback(async () => {
    try {
      const filters = {}
      if (statusFilter !== 'all') filters.status = statusFilter
      if (search) filters.search = search
      setApps(await client.getApplications(filters))
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [client, statusFilter, search])

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0) // debounce while typing
    return () => clearTimeout(t)
  }, [load, search])

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  if (selectedId) {
    return (
      <ApplicationDetailScreen
        client={client}
        id={selectedId}
        onBack={() => { setSelectedId(null); load() }}
      />
    )
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Applications</Text>

      <TextInput
        style={styles.search}
        value={search}
        onChangeText={setSearch}
        placeholder="Search title or company…"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
      />

      <View style={styles.filterRow}>
        {STATUS_FILTERS.map(f => (
          <TouchableOpacity
            key={f}
            style={[styles.filterChip, statusFilter === f && styles.filterChipActive]}
            onPress={() => setStatusFilter(f)}
          >
            <Text style={[styles.filterText, statusFilter === f && styles.filterTextActive]}>{f}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {!!error && <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={apps}
        keyExtractor={item => String(item.id)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        ListEmptyComponent={<Text style={styles.empty}>No applications found</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.item} onPress={() => setSelectedId(item.id)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.itemTitle} numberOfLines={1}>{item.job_title}</Text>
              <Text style={styles.itemCompany} numberOfLines={1}>
                {item.company} · {item.platform}
              </Text>
              <Text style={styles.itemDate}>{(item.applied_at || '').slice(0, 16)}</Text>
            </View>
            <View style={styles.itemRight}>
              {item.match_score != null && (
                <Text style={styles.itemScore}>{item.match_score}%</Text>
              )}
              <View style={[styles.statusBadge, { borderColor: statusColors[item.status] || colors.border }]}>
                <Text style={[styles.statusText, { color: statusColors[item.status] || colors.textMuted }]}>
                  {item.status}
                </Text>
              </View>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: 12 },
  search: {
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius, paddingHorizontal: 12, paddingVertical: 9,
    color: colors.text, fontSize: 14, marginBottom: 10,
  },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  filterChip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  filterChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  filterText: { fontSize: 12, color: colors.textMuted, textTransform: 'capitalize' },
  filterTextActive: { color: '#fff', fontWeight: '600' },
  error: { color: colors.red, fontSize: 13, marginBottom: 10 },
  empty: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: 32 },
  item: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius, padding: 14, marginBottom: 8,
  },
  itemTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  itemCompany: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  itemDate: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  itemRight: { alignItems: 'flex-end', gap: 6 },
  itemScore: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  statusBadge: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontSize: 10, fontWeight: '600', textTransform: 'uppercase' },
})
