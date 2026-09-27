import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View, Text, FlatList, TextInput, TouchableOpacity, ScrollView,
  RefreshControl, StyleSheet, ActivityIndicator, Platform,
} from 'react-native'
import { radius, statusLabel, STATUS_FILTERS, useTheme, useStatusColors } from '../theme'
import ApplicationDetailScreen from './ApplicationDetailScreen'
import { describeDue, isOverdue } from '../components/NextAction'
import { formatWhen } from '../dates'

export default function ApplicationsScreen({ client, openApplicationId, onOpened, resetSignal }) {
  // Palette and stylesheet follow the phone's appearance setting. Named
  // `colors` so every inline reference below reads unchanged.
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const statusColors = useStatusColors()

  // null until the first load lands, so an empty list is not announced as
  // "No applications found" while it is still being fetched.
  const [apps, setApps] = useState(null)
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

  // A notification tap names the application it was about. Landing on the list
  // and making the user find it again would waste the one thing a notification is
  // good for.
  useEffect(() => {
    if (openApplicationId == null) return
    setSelectedId(openApplicationId)
    onOpened?.()
  }, [openApplicationId, onOpened])

  // A second tap on the Applications tab closes an open application. Compared
  // against the value seen at mount, so mounting does not count as a tap.
  const [lastReset, setLastReset] = useState(resetSignal)
  if (resetSignal !== lastReset) {
    setLastReset(resetSignal)
    setSelectedId(null)
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

      <View style={styles.searchWrap}>
        <TextInput
          style={styles.search}
          value={search}
          onChangeText={setSearch}
          placeholder="Search title or company…"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel="Search applications by title or company"
        />
        {/* iOS draws its own clear button; Android has none, and clearing a
            search by holding backspace is miserable one-handed. */}
        {!!search && Platform.OS === 'android' && (
          <TouchableOpacity style={styles.clearBtn} onPress={() => setSearch('')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button" accessibilityLabel="Clear search">
            <Text style={styles.clearText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* One scrolling row. Ten chips wrapped onto three lines and pushed the
          list itself half off a phone screen. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
        contentContainerStyle={styles.filterRow}
        keyboardShouldPersistTaps="handled"
      >
        {STATUS_FILTERS.map(f => (
          <TouchableOpacity
            key={f}
            accessibilityRole="button"
            accessibilityLabel={`Show ${f === 'all' ? 'all' : statusLabel(f)} applications`}
            accessibilityState={{ selected: statusFilter === f }}
            style={[styles.filterChip, statusFilter === f && styles.filterChipActive]}
            onPress={() => setStatusFilter(f)}
          >
            <Text style={[styles.filterText, statusFilter === f && styles.filterTextActive]}>{f === 'all' ? 'All' : statusLabel(f)}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {!!error && <Text style={styles.error}>{error}</Text>}
      {apps && apps.length > 0 && (
        <Text style={styles.count} accessibilityLiveRegion="polite">
          {apps.length} application{apps.length === 1 ? '' : 's'}
        </Text>
      )}

      <FlatList
        data={apps || []}
        keyExtractor={item => String(item.id)}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        ListEmptyComponent={
          apps == null
            ? (error ? null : <ActivityIndicator style={{ marginTop: 32 }} color={colors.accent} />)
            : (
              <Text style={styles.empty}>
                {search || statusFilter !== 'all'
                  ? 'Nothing matches this search or filter.'
                  : 'No applications yet. They appear here once the desktop has applied to something.'}
              </Text>
            )
        }
        renderItem={({ item }) => (
          // One announcement for the whole row rather than five fragments read
          // in layout order — a screen reader landing on this needs the job, the
          // company and what state it is in, in that order and as one thing.
          <TouchableOpacity
            style={styles.item}
            onPress={() => setSelectedId(item.id)}
            accessibilityRole="button"
            accessibilityLabel={
              `${item.job_title} at ${item.company}. ${statusLabel(item.status)}.`
              + `${item.match_score != null ? ` ${item.match_score} percent match.` : ''}`
              + `${item.next_action_at ? ` Follow-up ${describeDue(item.next_action_at)}${isOverdue(item.next_action_at) ? ', overdue' : ''}.` : ''}`
            }
            accessibilityHint="Opens the application"
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.itemTitle} numberOfLines={1}>{item.job_title}</Text>
              <Text style={styles.itemCompany} numberOfLines={1}>
                {item.company} · {item.platform}
              </Text>
              <Text style={styles.itemDate}>{formatWhen(item.applied_at)}</Text>
              {/* The follow-up, where the eye already is. A date buried one tap
                  deeper is a date nobody acts on. */}
              {!!item.next_action_at && (
                <Text style={[styles.itemDate, isOverdue(item.next_action_at) && styles.itemOverdue]}>
                  {isOverdue(item.next_action_at) ? '⚑ ' : ''}
                  {item.next_action_note || 'Follow up'} · {describeDue(item.next_action_at)}
                </Text>
              )}
            </View>
            <View style={styles.itemRight}>
              {item.match_score != null && (
                <Text style={styles.itemScore}>{item.match_score}%</Text>
              )}
              <View style={[styles.statusBadge, { borderColor: statusColors[item.status] || colors.border }]}>
                <Text style={[styles.statusText, { color: statusColors[item.status] || colors.textMuted }]}>
                  {statusLabel(item.status)}
                </Text>
              </View>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  )
}

// Rebuilt per palette — see useTheme() in ../theme.
const makeStyles = (c) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg, padding: 16 },
  title: { fontSize: 22, fontWeight: '700', color: c.text, marginBottom: 12 },
  searchWrap: { justifyContent: 'center', marginBottom: 10 },
  search: {
    backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border,
    borderRadius: radius, paddingHorizontal: 12, paddingVertical: 10, paddingRight: 36,
    color: c.text, fontSize: 15, minHeight: 44,
  },
  clearBtn: { position: 'absolute', right: 10, padding: 4 },
  clearText: { color: c.textMuted, fontSize: 14 },
  // flexGrow: 0 or the horizontal ScrollView stretches to fill the column and
  // shoves the list to the bottom of the screen.
  filterScroll: { flexGrow: 0, marginHorizontal: -16, marginBottom: 10 },
  filterRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 16 },
  // 36pt tall plus the row's spacing keeps each chip comfortably tappable
  // without the row taking over the screen.
  filterChip: {
    paddingHorizontal: 14, minHeight: 36, justifyContent: 'center', borderRadius: 18,
    borderWidth: 1, borderColor: c.border, backgroundColor: c.surface,
  },
  count: { color: c.textFaint, fontSize: 12, marginBottom: 8 },
  filterChipActive: { backgroundColor: c.accent, borderColor: c.accent },
  filterText: { fontSize: 13, color: c.textMuted },
  filterTextActive: { color: '#fff', fontWeight: '600' },
  error: { color: c.red, fontSize: 13, marginBottom: 10 },
  empty: { color: c.textMuted, fontSize: 13, textAlign: 'center', marginTop: 32, lineHeight: 19, paddingHorizontal: 16 },
  item: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
    borderRadius: radius, padding: 14, marginBottom: 8,
  },
  itemTitle: { color: c.text, fontSize: 14, fontWeight: '600' },
  itemCompany: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  itemOverdue: { color: c.red },
  itemDate: { color: c.textMuted, fontSize: 11, marginTop: 2 },
  itemRight: { alignItems: 'flex-end', gap: 6 },
  itemScore: { color: c.accent, fontSize: 13, fontWeight: '700' },
  statusBadge: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontSize: 10, fontWeight: '600', textTransform: 'uppercase' },
})
