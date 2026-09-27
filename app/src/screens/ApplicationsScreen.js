import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View, Text, FlatList, TextInput, TouchableOpacity, ScrollView,
  RefreshControl, StyleSheet, ActivityIndicator, Platform, Alert, ActionSheetIOS,
} from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { radius, statusLabel, STATUS_FILTERS, useTheme, useStatusColors } from '../theme'
import ApplicationDetailScreen from './ApplicationDetailScreen'
import { describeDue, isOverdue } from '../components/NextAction'
import SwipeRow from '../components/SwipeRow'
import { formatWhen, localDateIn } from '../dates'
import { SORTS, sortApplications } from '../listing'
import { selection, success, failure } from '../haptics'

// Per-phone conveniences, not account state: the chosen order, and whether the
// swipe hint has been dismissed. AsyncStorage is right for both — losing either
// costs a tap.
const SORT_KEY = 'hiro.applications.sort'
const SWIPE_HINT_KEY = 'hiro.applications.swipeHintSeen'

// Rows a quick action makes no sense on. A held draft needs its review, which
// is on the detail page; a skipped row was never sent, so there is nobody to
// interview with or be rejected by.
const NO_QUICK_ACTIONS = ['held', 'skipped']

export default function ApplicationsScreen({ client, active = true, openApplicationId, onOpened, resetSignal, onChanged }) {
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
  const [sort, setSort] = useState('newest')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  // The one row whose quick actions are showing. Owned here so opening a row
  // closes the last one.
  const [openRow, setOpenRow] = useState(null)
  const [showSwipeHint, setShowSwipeHint] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(SORT_KEY)
        if (saved && SORTS.some(s => s.id === saved)) setSort(saved)
        setShowSwipeHint((await AsyncStorage.getItem(SWIPE_HINT_KEY)) !== '1')
      } catch { /* defaults are fine */ }
    })()
  }, [])

  const dismissSwipeHint = useCallback(() => {
    setShowSwipeHint(false)
    AsyncStorage.setItem(SWIPE_HINT_KEY, '1').catch(() => {})
  }, [])

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

  // Tabs stay mounted now, so coming back to this one is not a remount and
  // would otherwise show whatever the list held when it was last visible.
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current && selectedId == null) load()
    wasActive.current = active
  }, [active, load, selectedId])

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const sorted = useMemo(() => (apps ? sortApplications(apps, sort) : null), [apps, sort])

  function chooseSort() {
    const pick = (id) => {
      if (!id || id === sort) return
      selection()
      setSort(id)
      AsyncStorage.setItem(SORT_KEY, id).catch(() => {})
    }
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({
        title: 'Sort applications',
        options: [...SORTS.map(s => (s.id === sort ? `✓ ${s.label}` : s.label)), 'Cancel'],
        cancelButtonIndex: SORTS.length,
      }, (i) => pick(SORTS[i]?.id))
    } else {
      Alert.alert('Sort applications', undefined, [
        ...SORTS.map(s => ({ text: s.id === sort ? `✓ ${s.label}` : s.label, onPress: () => pick(s.id) })),
        { text: 'Cancel', style: 'cancel' },
      ], { cancelable: true })
    }
  }

  // ── Quick actions ────────────────────────────────────────────────
  // Optimistic like the detail page's chips, and rolled back the same way.
  const patchRow = useCallback((id, patch) => {
    setApps(list => (list || []).map(a => (a.id === id ? { ...a, ...patch } : a)))
  }, [])

  const quickStatus = useCallback(async (item, status) => {
    setOpenRow(null)
    const before = { status: item.status }
    patchRow(item.id, { status })
    try {
      await client.updateStatus(item.id, status)
      success()
      setError('')
      onChanged?.()
      // A row that no longer matches the active filter should leave the list,
      // which only a reload does.
      if (statusFilter !== 'all') load()
    } catch (err) {
      patchRow(item.id, before)
      failure()
      setError(err.message)
    }
  }, [client, patchRow, onChanged, statusFilter, load])

  const quickFollowUp = useCallback(async (item, days) => {
    setOpenRow(null)
    const before = { next_action_at: item.next_action_at, next_action_note: item.next_action_note }
    const date = localDateIn(days)
    const note = item.next_action_note || 'Follow up'
    patchRow(item.id, { next_action_at: date, next_action_note: note })
    try {
      const res = await client.setNextAction(item.id, { date, note })
      if (res?.success === false) throw new Error(res.reason || 'Could not save the follow-up.')
      success()
      setError('')
      onChanged?.()
    } catch (err) {
      patchRow(item.id, before)
      failure()
      setError(err.message)
    }
  }, [client, patchRow, onChanged])

  const actionsFor = useCallback((item) => {
    if (NO_QUICK_ACTIONS.includes(item.status)) return []
    const out = []
    if (client.setNextAction) {
      out.push({
        key: 'follow', label: 'Follow up\n1 week', color: colors.accent,
        accessibilityLabel: 'Follow up in a week', onPress: () => quickFollowUp(item, 7),
      })
    }
    if (item.status !== 'interview') {
      out.push({ key: 'interview', label: 'Interview', color: colors.green, onPress: () => quickStatus(item, 'interview') })
    }
    if (item.status !== 'rejected') {
      out.push({
        key: 'rejected', label: 'Rejected', color: colors.red,
        accessibilityLabel: 'Mark rejected', onPress: () => quickStatus(item, 'rejected'),
      })
    }
    return out
  }, [client, colors, quickFollowUp, quickStatus])

  // The same actions, for anyone who never swipes.
  function showActionMenu(item) {
    const actions = actionsFor(item)
    if (!actions.length) return
    selection()
    const labels = actions.map(a => (a.accessibilityLabel || a.label).replace('\n', ' '))
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({
        title: `${item.job_title} · ${item.company}`,
        options: [...labels, 'Open', 'Cancel'],
        cancelButtonIndex: labels.length + 1,
        destructiveButtonIndex: actions.some(a => a.key === 'rejected')
          ? actions.findIndex(a => a.key === 'rejected') : undefined,
      }, (i) => {
        if (i < actions.length) actions[i].onPress()
        else if (i === actions.length) setSelectedId(item.id)
      })
    } else {
      // Android's Alert shows at most three buttons, which is exactly the
      // actions: "Open" is what a plain tap already does, and tapping outside
      // the dialog (or back) is the cancel.
      Alert.alert(`${item.job_title}`, item.company,
        actions.slice(0, 3).map((a, i) => ({ text: labels[i], onPress: a.onPress })),
        { cancelable: true })
    }
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
        active={active}
        onChanged={onChanged}
        onBack={() => { setSelectedId(null); load() }}
      />
    )
  }

  const sortLabel = SORTS.find(s => s.id === sort)?.label || 'Newest'

  return (
    <View style={styles.root}>
      <Text style={styles.title} accessibilityRole="header">Applications</Text>

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
            onPress={() => { if (f !== statusFilter) selection(); setStatusFilter(f) }}
          >
            <Text style={[styles.filterText, statusFilter === f && styles.filterTextActive]}>{f === 'all' ? 'All' : statusLabel(f)}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {!!error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.listHead}>
        <Text style={styles.count} accessibilityLiveRegion="polite">
          {sorted && sorted.length > 0 ? `${sorted.length} application${sorted.length === 1 ? '' : 's'}` : ''}
        </Text>
        <TouchableOpacity onPress={chooseSort} style={styles.sortBtn}
          hitSlop={{ top: 6, bottom: 6, left: 10, right: 6 }}
          accessibilityRole="button" accessibilityLabel={`Sort: ${sortLabel}`}
          accessibilityHint="Changes the order of the list">
          <Text style={styles.sortText}>Sort: {sortLabel} ▾</Text>
        </TouchableOpacity>
      </View>

      {showSwipeHint && sorted && sorted.some(a => !NO_QUICK_ACTIONS.includes(a.status)) && (
        <TouchableOpacity style={styles.hint} onPress={dismissSwipeHint}
          accessibilityRole="button" accessibilityLabel="Tip: swipe a row left, or press and hold it, for quick actions. Tap to dismiss.">
          <Text style={styles.hintText}>
            Tip: swipe a row left — or press and hold — to book a follow-up or update its status.
          </Text>
          <Text style={styles.hintClose}>✕</Text>
        </TouchableOpacity>
      )}

      <FlatList
        data={sorted || []}
        extraData={openRow}
        keyExtractor={item => String(item.id)}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: 16 }}
        onScrollBeginDrag={() => openRow != null && setOpenRow(null)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        ListEmptyComponent={
          sorted == null
            ? (error ? null : <ActivityIndicator style={{ marginTop: 32 }} color={colors.accent} />)
            : (
              <Text style={styles.empty}>
                {search || statusFilter !== 'all'
                  ? 'Nothing matches this search or filter.'
                  : 'No applications yet. They appear here once the desktop has applied to something.'}
              </Text>
            )
        }
        renderItem={({ item }) => {
          const actions = actionsFor(item)
          return (
            <SwipeRow
              actions={actions}
              open={openRow === item.id}
              onOpen={() => { setOpenRow(item.id); if (showSwipeHint) dismissSwipeHint() }}
              onClose={() => setOpenRow(o => (o === item.id ? null : o))}
              style={styles.rowWrap}
            >
              {/* One announcement for the whole row rather than five fragments
                  read in layout order — a screen reader landing on this needs the
                  job, the company and what state it is in, as one thing. */}
              <TouchableOpacity
                style={styles.item}
                activeOpacity={0.7}
                onPress={() => {
                  // A tap on an open row closes it, rather than opening the
                  // application underneath the half-read actions.
                  if (openRow != null) { setOpenRow(null); return }
                  setSelectedId(item.id)
                }}
                onLongPress={() => showActionMenu(item)}
                delayLongPress={350}
                accessibilityRole="button"
                accessibilityLabel={
                  `${item.job_title} at ${item.company}. ${statusLabel(item.status)}.`
                  + `${item.match_score != null ? ` ${item.match_score} percent match.` : ''}`
                  + `${item.next_action_at ? ` Follow-up ${describeDue(item.next_action_at)}${isOverdue(item.next_action_at) ? ', overdue' : ''}.` : ''}`
                }
                accessibilityHint="Opens the application"
                accessibilityActions={actions.map(a => ({ name: a.key, label: (a.accessibilityLabel || a.label).replace('\n', ' ') }))}
                onAccessibilityAction={(e) => actions.find(a => a.key === e.nativeEvent.actionName)?.onPress()}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemTitle} numberOfLines={1}>{item.job_title}</Text>
                  <Text style={styles.itemCompany} numberOfLines={1}>
                    {item.company} · {item.platform}
                  </Text>
                  <Text style={styles.itemDate}>{formatWhen(item.applied_at)}</Text>
                  {/* The follow-up, where the eye already is. A date buried one
                      tap deeper is a date nobody acts on. */}
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
            </SwipeRow>
          )
        }}
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
  filterScroll: { flexGrow: 0, marginHorizontal: -16, marginBottom: 6 },
  filterRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 16 },
  // 36pt tall plus the row's spacing keeps each chip comfortably tappable
  // without the row taking over the screen.
  filterChip: {
    paddingHorizontal: 14, minHeight: 36, justifyContent: 'center', borderRadius: 18,
    borderWidth: 1, borderColor: c.border, backgroundColor: c.surface,
  },
  filterChipActive: { backgroundColor: c.accent, borderColor: c.accent },
  filterText: { fontSize: 13, color: c.textMuted },
  filterTextActive: { color: '#fff', fontWeight: '600' },
  listHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    minHeight: 36, marginBottom: 4,
  },
  count: { color: c.textFaint, fontSize: 12 },
  sortBtn: { minHeight: 36, justifyContent: 'center' },
  sortText: { color: c.accent, fontSize: 13, fontWeight: '600' },
  hint: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surface2, borderRadius: radius, padding: 10, marginBottom: 8,
  },
  hintText: { flex: 1, color: c.textMuted, fontSize: 12, lineHeight: 17 },
  hintClose: { color: c.textFaint, fontSize: 13 },
  error: { color: c.red, fontSize: 13, marginBottom: 6 },
  empty: { color: c.textMuted, fontSize: 13, textAlign: 'center', marginTop: 32, lineHeight: 19, paddingHorizontal: 16 },
  // The corner and gap live on the swipe wrapper so the revealed actions are
  // clipped to the same rounded card as the row sliding over them.
  rowWrap: { borderRadius: radius, marginBottom: 8 },
  item: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
    borderRadius: radius, padding: 14,
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
