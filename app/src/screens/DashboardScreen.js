import CloudCommands from '../components/CloudCommands'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { View, Text, ScrollView, RefreshControl, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Linking, Platform, AppState, Keyboard } from 'react-native'
import { radius, statusLabel, useTheme, useStatusColors } from '../theme'
import { describeDue, isOverdue } from '../components/NextAction'
import * as Clipboard from 'expo-clipboard'
import { enqueue, flush, getPending } from '../scanQueue'
import ScanQueue, { describeFlush } from '../components/ScanQueue'
import { parseLocal, relativeDay, calendarDaysFrom, formatWhen, clockTime, formatDay } from '../dates'
import { classifyError, messageFor } from '../requestErrors'
import { randomKey } from '../secureProtocol'
import { saveCache, loadCache, shouldUseCache } from '../offlineCache'
import { slimDashboard, cachedLabel } from '../cacheModel'
import { addInterviewToCalendar } from '../addToCalendar'
import { importJobLink } from '../importJob'
import { extractJobUrl } from '../importLink'

// While showing cached figures, how often to try the source again.
const CACHE_RETRY_MS = 30000

export default function DashboardScreen({ client, active = true, onOpenApplication, onNeedsPairing, queueSignal = 0 }) {
  // Palette and stylesheet follow the phone's appearance setting. Named
  // `colors` so every inline reference below reads unchanged.
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const statusColors = useStatusColors()

  const [stats, setStats] = useState(null)
  const [perDay, setPerDay] = useState([])
  const [attention, setAttention] = useState([])
  const [interviews, setInterviews] = useState([])
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const [keywords, setKeywords] = useState('')
  const [scanStatus, setScanStatus] = useState(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [pendingCount, setPendingCount] = useState(0)
  const [liveLog, setLiveLog] = useState([])
  const [cancelBusy, setCancelBusy] = useState(false)
  const [dueActions, setDueActions] = useState([])
  // Set when the poll below has given up on an unreachable desktop, so the UI
  // can say the connection was lost instead of showing a scan running forever.
  const [scanPollLost, setScanPollLost] = useState(false)
  // The cache entry on screen when the source could not be reached, else null.
  const [cached, setCached] = useState(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  // Interview id -> 'added' or the reason it was not, for this session.
  const [calendarDone, setCalendarDone] = useState({})

  const load = useCallback(async () => {
    let s, pd
    try {
      [s, pd] = await Promise.all([client.getStats(), client.getPerDay(7)])
    } catch (err) {
      // Unreachable: show the last figures this phone saw, marked as such,
      // rather than an empty screen with an error on it.
      if (shouldUseCache(err)) {
        const entry = await loadCache(client, 'dashboard')
        if (entry) {
          setStats(entry.data.stats)
          setPerDay(entry.data.perDay)
          setInterviews(entry.data.interviews)
          setDueActions(entry.data.dueActions)
          setAttention([])
          setScanStatus(null)
          setCached(entry)
          setError('')
          return
        }
      }
      setCached(null)
      setError(messageFor(err))
      if (classifyError(err) === 'auth') onNeedsPairing?.()
      return
    }
    setStats(s)
    setPerDay(pd)
    setError('')
    setCached(null)
    // Interviews are available over both transports now. A desktop or schema
    // that can't serve them returns an empty list; any other failure leaves the
    // panel empty rather than breaking the dashboard.
    let iv = [], due = []
    try { iv = await client.getUpcomingInterviews(10) } catch { iv = [] }
    setInterviews(iv)
    // Attention jobs are mirrored to the cloud too, so this no longer needs
    // a live desktop — but the scan-status and queue polling below does.
    try { setAttention(await client.getAttention()) } catch { setAttention([]) }
    // Follow-ups that have come due.
    try { due = (await client.getDueActions?.()) || [] } catch { due = [] }
    setDueActions(due)
    saveCache(client, 'dashboard', slimDashboard({ stats: s, perDay: pd, interviews: iv, dueActions: due }))
    if (client.canScan) {
      // Reachable — deliver anything queued while it was not. A queue that
      // cannot be read is reported by the <ScanQueue> card itself.
      try {
        const result = await flush(client)
        const note = describeFlush(result)
        if (note) setScanMsg(note)
        if (result.needsPairing) onNeedsPairing?.()
      } catch { /* shown by <ScanQueue> */ }
      // Clear on failure rather than keep displaying stale running/queued info.
      try { setScanStatus(await client.getScanStatus()) } catch { setScanStatus(null) }
      try { setPendingCount((await getPending()).length) } catch { /* shown by <ScanQueue> */ }
    }
  }, [client, onNeedsPairing])

  async function onRunScan() {
    if (scanBusy) return
    Keyboard.dismiss()
    setScanBusy(true)
    setScanMsg('')
    // Minted before the first attempt and kept with the request if it has to
    // wait, so a retry after a timeout that DID reach the desktop is recognised
    // there as the same scan.
    const req = { keywords: keywords.trim(), location: '', createdAt: new Date().toISOString(), idempotencyKey: randomKey() }
    try {
      const info = await client.requestScan({ keywords: req.keywords }, { idempotencyKey: req.idempotencyKey })
      if (info.cloud) {
        // Queued via Supabase — the desktop drains requests on its next sync.
        setScanMsg('Scan queued via the cloud — the desktop will pick it up within a couple of minutes.')
        // Refresh the status so the queued count shows and live polling starts.
        try { setScanStatus(await client.getScanStatus()) } catch { /* status is decorative */ }
      } else {
        setScanStatus(info)
        setScanMsg(info.running ? 'A scan is already running on the desktop — queued next.' : 'Scan queued — running on the desktop now.')
      }
    } catch (err) {
      // Only an unreachable destination is worth queueing for. Every failure
      // used to be queued as "Desktop offline" — including requests that would
      // be refused however often they were retried.
      const kind = classifyError(err)
      if (kind === 'offline') {
        try {
          await enqueue(req, client)
          setPendingCount((await getPending()).length)
          setScanMsg(`Can’t reach it right now, so the scan was saved and will be sent when it is back. (${err.message || 'Destination unavailable.'})`)
        } catch (queueError) {
          setScanMsg(`Request was not saved: ${queueError.message}`)
        }
      } else if (kind === 'auth') {
        setScanMsg(`Scan not sent: ${err.message}`)
        onNeedsPairing?.()
      } else if (kind === 'busy') {
        setScanMsg(`Scan not sent — the desktop is busy or has locked this phone out for now: ${err.message}. Try again in a few minutes.`)
      } else {
        setScanMsg(err.scope ? messageFor(err) : `Scan not sent: ${err.message}`)
      }
    } finally {
      setScanBusy(false)
    }
  }

  // "Import job from clipboard": the fallback for an app that cannot share
  // into Hiro, and for iOS, where the share-sheet entry is not built.
  async function onImportFromClipboard() {
    if (importBusy) return
    setImportBusy(true)
    setImportMsg('')
    try {
      const url = extractJobUrl(await Clipboard.getStringAsync())
      if (!url) {
        setImportMsg('The clipboard has no job link in it. Copy the posting’s URL first.')
        return
      }
      const res = await importJobLink(client, { url })
      setImportMsg(res.message)
      if (res.status === 'queued') setPendingCount((await getPending().catch(() => [])).length)
      if (res.status === 'auth') onNeedsPairing?.()
    } catch (err) {
      setImportMsg(err.message)
    } finally {
      setImportBusy(false)
    }
  }

  async function onAddToCalendar(iv) {
    const res = await addInterviewToCalendar(iv)
    setCalendarDone(d => ({ ...d, [iv.id]: res.added ? 'added' : (res.reason || 'Not added') }))
  }

  useEffect(() => { load() }, [load])

  // Something outside this screen queued a request (a shared job link).
  useEffect(() => {
    if (!queueSignal) return
    getPending().then(r => setPendingCount(r.length)).catch(() => {})
  }, [queueSignal])

  // Tabs stay mounted, so returning to this one is not a remount. Reload on the
  // way back in, or the tiles show whatever was true when it was last on screen.
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) load()
    wasActive.current = active
  }, [active, load])

  // Live scan progress: while the desktop is scanning (or scans are queued),
  // poll the status — and over LAN also the activity log, so the user can
  // watch the scan work ("Found 14 jobs on Seek… applying…") in real time.
  // Cloud mode polls status only, at a gentler rate (each tick is a Supabase
  // read); LAN talks straight to the desktop so 4s is cheap.
  const scanActive = !!(scanStatus?.running || scanStatus?.queued > 0)
  // Cleared whenever a scan starts again, so giving up once does not poison the
  // next scan's polling.
  useEffect(() => { if (!scanActive) setScanPollLost(false) }, [scanActive])

  // The phone's own foreground state. A 4-second network call has no business
  // running behind a locked screen: iOS suspends JS timers soon after
  // backgrounding but Android does not, so this used to keep polling — and
  // draining the battery — for as long as the app stayed in memory.
  const appActive = useRef(true)
  const [foreground, setForeground] = useState(true)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      appActive.current = state === 'active'
      setForeground(state === 'active')
    })
    return () => sub.remove()
  }, [])

  useEffect(() => {
    // Paused while another tab is in front, as it is while the phone is locked:
    // nobody is watching the feed, and returning reloads everything anyway.
    if (!scanActive || !foreground || !active || scanPollLost) return
    let cancelled = false
    let finishing = false
    // The exit condition is derived from scanStatus, and a failed tick used to
    // leave the previous `running: true` in place — so a desktop that went away
    // mid-scan (laptop closed, Wi-Fi dropped) left this spinning at 4s forever,
    // with pull-to-refresh the only way out. Give up after a few consecutive
    // failures and say so.
    const MAX_CONSECUTIVE_FAILURES = 4
    let failures = 0
    const tick = async () => {
      try {
        const [status, logs] = await Promise.all([
          client.getScanStatus(),
          client.getLogs ? client.getLogs(40) : Promise.resolve(null),
        ])
        if (cancelled) return
        failures = 0
        if (logs?.lines) setLiveLog(logs.lines)
        setScanStatus(status)
        // Scan finished — refresh stats/chart once so new applications show up.
        if (status && !status.running && !(status.queued > 0) && !finishing) {
          finishing = true
          load()
        }
      } catch {
        if (cancelled) return
        failures++
        if (failures >= MAX_CONSECUTIVE_FAILURES) setScanPollLost(true)
      }
    }
    const id = setInterval(tick, client.getLogs ? 4000 : 10000)
    tick()
    return () => { cancelled = true; clearInterval(id) }
  }, [scanActive, foreground, active, scanPollLost, client, load])

  // Showing cached figures: keep trying quietly, and swap in the live ones the
  // moment the source answers — straight away on returning to the foreground,
  // the likeliest moment the network is back. Only while someone is looking.
  const showingCache = !!cached
  useEffect(() => {
    if (!showingCache || !foreground || !active) return
    load()
    const id = setInterval(load, CACHE_RETRY_MS)
    return () => clearInterval(id)
  }, [showingCache, foreground, active, load])

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
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      // Without "handled" the first tap on "Run scan now" with the keyboard up
      // only dismissed the keyboard, and the scan needed a second tap.
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
    >
      <View style={styles.titleRow}>
        <Text style={styles.title}>Dashboard</Text>
        {!!cached && (
          <Text style={styles.cachedBadge} accessibilityLabel={`Showing ${cachedLabel(cached)}`}>
            {cachedLabel(cached)}
          </Text>
        )}
      </View>
      {!!cached && (
        <Text style={styles.cachedNote} accessibilityLiveRegion="polite">
          Can’t reach {client.queueDestination?.key?.startsWith('lan:') ? 'the desktop' : 'your Hiro cloud'} right now — these are the last
          figures this phone saw. They refresh on their own when the connection is back.
        </Text>
      )}
      <ScanQueue client={client} refreshKey={pendingCount} onChanged={setPendingCount} onNeedsPairing={onNeedsPairing} />
      {!!error && <Text style={styles.error}>{error}</Text>}
      {!stats && !error && <ActivityIndicator style={{ marginVertical: 24 }} color={colors.accent} />}

      {/* Trigger a scan on the desktop (LAN connection only) */}
      {client.canScan && (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Run a scan</Text>
        {scanStatus && (
          <Text style={styles.muted}>
            Desktop: {scanStatus.running
              ? 'scanning now…'
              : scanStatus.busy ? 'busy (applying)' : 'idle'}
            {scanStatus.queued > 0 ? ` · ${scanStatus.queued} queued` : ''}
            {scanStatus.lastScanAt ? ` · last ${formatWhen(scanStatus.lastScanAt)}` : ''}
          </Text>
        )}
        {/* A failed scan used to be indistinguishable from one that found
            nothing — the desktop now reports how the last scan actually ended. */}
        {!!scanStatus?.lastScanError && !scanStatus.running && (
          <Text style={styles.scanError}>Last scan failed: {scanStatus.lastScanError}</Text>
        )}
        <TextInput
          style={styles.input}
          placeholder="Keywords (optional — blank uses desktop settings)"
          placeholderTextColor={colors.textMuted}
          value={keywords}
          onChangeText={setKeywords}
          autoCapitalize="none"
          returnKeyType="go"
          onSubmitEditing={onRunScan}
          accessibilityLabel="Scan keywords"
        />
        <TouchableOpacity style={[styles.scanBtn, scanBusy && { opacity: 0.6 }]} onPress={onRunScan} disabled={scanBusy}
          accessibilityRole="button" accessibilityLabel="Run a scan now"
          accessibilityHint="Asks the desktop to search for jobs"
          accessibilityState={{ disabled: scanBusy, busy: scanBusy }}>
          {scanBusy
            ? <ActivityIndicator color="#fff" accessibilityElementsHidden importantForAccessibility="no" />
            : <Text style={styles.scanBtnText}>Run scan now</Text>}
        </TouchableOpacity>
        {scanStatus?.running && !!client.cancelScan && (
          <TouchableOpacity style={[styles.cancelBtn, cancelBusy && { opacity: 0.6 }]} onPress={onCancelScan} disabled={cancelBusy}
            accessibilityRole="button" accessibilityLabel="Cancel the running scan"
            accessibilityHint="Stops the desktop partway; anything already submitted stays"
            accessibilityState={{ disabled: cancelBusy, busy: cancelBusy }}>
            <Text style={styles.cancelBtnText}>{cancelBusy ? 'Cancelling…' : 'Cancel scan'}</Text>
          </TouchableOpacity>
        )}
        {pendingCount > 0 && <Text style={styles.pending}>{pendingCount} scan{pendingCount > 1 ? 's' : ''} waiting to send to the desktop</Text>}
        {!!scanMsg && <Text style={styles.scanMsg} accessibilityLiveRegion="polite">{scanMsg}</Text>}
        {/* The poll gave up rather than spinning on an unreachable desktop.
            Say which it is: "still scanning" and "I stopped being able to ask"
            look identical otherwise, and only one of them is worth waiting on. */}
        {scanPollLost && (
          <Text style={styles.scanLost} accessibilityLiveRegion="polite">
            Lost contact with the desktop, so this stopped checking. It may still be
            scanning — pull down to refresh.
          </Text>
        )}

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

      {/* A job link copied from a browser or a job-board app. LAN only: the
          import lands in the desktop's Needs Attention list. */}
      {client.canImport && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Import a job</Text>
          <Text style={styles.muted}>
            Copy a posting’s link, then add it to Needs Attention on the desktop. You can also share a
            link into Hiro from another app.
          </Text>
          <TouchableOpacity style={[styles.ghostBtn, importBusy && { opacity: 0.6 }]} onPress={onImportFromClipboard} disabled={importBusy}
            accessibilityRole="button" accessibilityLabel="Import job from clipboard"
            accessibilityHint="Sends the link on your clipboard to the desktop"
            accessibilityState={{ disabled: importBusy, busy: importBusy }}>
            <Text style={styles.ghostBtnText}>{importBusy ? 'Importing…' : 'Import job from clipboard'}</Text>
          </TouchableOpacity>
          {!!importMsg && <Text style={styles.scanMsg} accessibilityLiveRegion="polite">{importMsg}</Text>}
        </View>
      )}

      {/* First run: nothing has been sent yet, and a wall of zeros explains
          nothing. Say where the numbers come from. */}
      {stats && !stats.totalAllTime && !(stats.byStatus || []).length && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Nothing here yet</Text>
          <Text style={styles.muted}>
            Applications appear once the Hiro desktop app has run its first scan.
            {client.canScan ? ' You can start one from here.' : ''}
          </Text>
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
            <StatCard label="Interview Rate" value={`${stats.interviewRate ?? 0}%`} />
          </View>
          {/* Older desktop builds don't publish attention jobs to the cloud
              (attentionCount: null) — hide the tile instead of showing a
              misleading 0. */}
          {stats.attentionCount != null && (
            <View style={styles.statRow}>
              <StatCard label="Needs Attention" value={stats.attentionCount} accent={stats.attentionCount > 0 ? colors.yellow : undefined} />
            </View>
          )}

          {/* Follow-ups that have come due, above the interviews on purpose: an
              overdue chase is the thing that is actively being lost, and it is the
              one item on this screen the user can act on right now. */}
          {dueActions.length > 0 && (
            <View style={[styles.card, {
              borderLeftWidth: 3,
              borderLeftColor: dueActions.some(a => isOverdue(a.next_action_at)) ? colors.red : colors.accent,
            }]}>
              <Text style={styles.cardTitle}>
                {dueActions.length} follow-up{dueActions.length === 1 ? '' : 's'} due
              </Text>
              {dueActions.map(a => (
                <TouchableOpacity key={a.id} style={styles.attentionRow}
                  disabled={!onOpenApplication}
                  onPress={() => onOpenApplication?.(a.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${a.next_action_note || 'Follow up'}: ${a.job_title} at ${a.company}, ${describeDue(a.next_action_at)}`}
                  accessibilityHint="Opens the application">
                  <View style={{ flex: 1 }}>
                    <Text style={styles.attentionTitle} numberOfLines={1}>
                      {a.next_action_note || 'Follow up'}
                    </Text>
                    <Text style={styles.muted} numberOfLines={1}>{a.job_title} · {a.company}</Text>
                  </View>
                  <Text style={[styles.attentionScore, {
                    color: isOverdue(a.next_action_at) ? colors.red : colors.accent,
                  }]}>{describeDue(a.next_action_at)}</Text>
                  <Text style={styles.chevron} importantForAccessibility="no">›</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Upcoming interviews — mirrored from the desktop, which detects them
              from recruiter replies. Read-only here. */}
          {interviews.length > 0 && (
            <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: colors.green }]}>
              <Text style={styles.cardTitle}>Upcoming interviews</Text>
              {interviews.map(iv => {
                // scheduled_at is the desktop's wall-clock time, and may be a
                // bare date — parseLocal keeps a bare date on its own day.
                const when = parseLocal(iv.scheduled_at)
                if (!when) return null
                const days = calendarDaysFrom(when)
                const rel = relativeDay(when)
                const hasTime = iv.has_time === true || iv.has_time === 1
                const appId = iv.application_id
                const calendarState = calendarDone[iv.id]
                return (
                  <View key={iv.id}>
                    <TouchableOpacity style={styles.attentionRow}
                      disabled={appId == null || !onOpenApplication}
                      onPress={() => onOpenApplication?.(appId)}
                      accessibilityRole="button"
                      accessibilityLabel={`Interview: ${iv.job_title} at ${iv.company}, ${rel}${hasTime ? ` at ${clockTime(when)}` : ''}`}
                      accessibilityHint={appId != null ? 'Opens the application' : undefined}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.attentionTitle} numberOfLines={1}>{iv.job_title}</Text>
                        <Text style={styles.muted} numberOfLines={1}>
                          {iv.company} · {formatDay(iv.scheduled_at)}
                          {hasTime ? ` at ${clockTime(when)}` : ' (time not detected)'}
                        </Text>
                      </View>
                      <Text style={[styles.attentionScore, { color: days <= 1 ? colors.green : colors.textMuted }]}>{rel}</Text>
                      {appId != null && <Text style={styles.chevron} importantForAccessibility="no">›</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.calendarBtn}
                      disabled={calendarState === 'added'}
                      onPress={() => onAddToCalendar(iv)}
                      accessibilityRole="button"
                      accessibilityLabel={`Add the ${iv.company} interview to your calendar`}
                      accessibilityState={{ disabled: calendarState === 'added' }}>
                      <Text style={styles.calendarBtnText}>
                        {calendarState === 'added' ? '✓ Added to calendar' : 'Add to calendar'}
                      </Text>
                    </TouchableOpacity>
                    {!!calendarState && calendarState !== 'added' && (
                      <Text style={styles.scanError} accessibilityLiveRegion="polite">{calendarState}</Text>
                    )}
                  </View>
                )
              })}
            </View>
          )}

          {/* Last 7 days bar chart */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Last 7 days</Text>
            <View style={styles.chart}>
              {perDay.length === 0 && <Text style={styles.muted}>No applications yet</Text>}
              {perDay.map(d => (
                <View key={d.date} style={styles.chartRow}
                  accessible
                  accessibilityRole="text"
                  accessibilityLabel={`${formatDay(d.date)}: ${d.count} application${d.count === 1 ? '' : 's'}`}>
                  <Text style={styles.chartLabel}>{formatDay(d.date).split(' ')[0]}</Text>
                  <View style={styles.chartTrack}>
                    <View style={[styles.chartBar, { width: `${(d.count / maxPerDay) * 100}%` }]} />
                  </View>
                  <Text style={styles.chartValue}>{d.count}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* Jobs flagged for manual application (LAN only — these don't sync) */}
          {attention.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Needs attention ({attention.length})</Text>
              {attention.slice(0, 5).map(job => (
                <TouchableOpacity
                  key={job.id}
                  style={styles.attentionRow}
                  disabled={!job.job_url}
                  onPress={() => job.job_url && Linking.openURL(job.job_url)}
                  accessibilityRole="link"
                  accessibilityLabel={
                    `${job.job_title} at ${job.company}.`
                    + `${job.reason ? ` ${job.reason}.` : ''}`
                    + `${job.match_score != null ? ` ${job.match_score} percent match.` : ''}`
                  }
                  accessibilityHint={job.job_url ? 'Opens the posting in your browser' : undefined}
                  accessibilityState={{ disabled: !job.job_url }}
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
              <View key={s.status} style={styles.row} accessibilityRole="text"
                accessibilityLabel={`${statusLabel(s.status)}: ${s.count}`}>
                <View style={[styles.dot, { backgroundColor: statusColors[s.status] || colors.textMuted }]} />
                <Text style={styles.rowLabel}>{statusLabel(s.status)}</Text>
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
    <CloudCommands client={client} active={active} />
    </ScrollView>
  )
}

function StatCard({ label, value, accent }) {
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, accent ? { color: accent } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

// Rebuilt per palette — see useTheme() in ../theme.
const makeStyles = (c) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  title: { fontSize: 22, fontWeight: '700', color: c.text },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 16 },
  cachedBadge: {
    color: c.yellow, fontSize: 11, fontWeight: '600', borderWidth: 1, borderColor: c.yellow,
    borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden',
  },
  cachedNote: { color: c.textMuted, fontSize: 12, marginTop: -8, marginBottom: 12, lineHeight: 17 },
  ghostBtn: {
    borderWidth: 1, borderColor: c.border, borderRadius: radius, paddingVertical: 10, minHeight: 44,
    alignItems: 'center', justifyContent: 'center', marginTop: 10,
  },
  ghostBtnText: { color: c.accent, fontSize: 13, fontWeight: '600' },
  calendarBtn: { alignSelf: 'flex-start', paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  calendarBtnText: { color: c.accent, fontSize: 12, fontWeight: '600' },
  error: { color: c.red, fontSize: 13, marginBottom: 12 },
  statRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  statCard: {
    flex: 1, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
    borderRadius: radius, padding: 16, alignItems: 'center',
  },
  statValue: { fontSize: 26, fontWeight: '700', color: c.text },
  statLabel: { fontSize: 11, color: c.textMuted, marginTop: 4 },
  card: {
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
    borderRadius: radius, padding: 16, marginTop: 10,
  },
  cardTitle: { fontSize: 14, fontWeight: '600', color: c.text, marginBottom: 12 },
  muted: { color: c.textMuted, fontSize: 13 },
  input: {
    backgroundColor: c.bg, borderWidth: 1, borderColor: c.border, borderRadius: radius,
    color: c.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, marginTop: 10, minHeight: 44,
  },
  scanBtn: {
    backgroundColor: c.accent, borderRadius: radius, paddingVertical: 12, minHeight: 46,
    alignItems: 'center', justifyContent: 'center', marginTop: 10,
  },
  scanBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  cancelBtn: {
    borderWidth: 1, borderColor: c.red, borderRadius: radius,
    paddingVertical: 10, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8,
  },
  cancelBtnText: { color: c.red, fontSize: 13, fontWeight: '600' },
  liveLog: {
    backgroundColor: c.bg, borderWidth: 1, borderColor: c.border,
    borderRadius: radius, padding: 10, marginTop: 10, gap: 3,
  },
  liveLogLine: {
    color: c.textMuted, fontSize: 11, lineHeight: 15,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  scanLost: { color: c.yellow, fontSize: 12, marginTop: 8, lineHeight: 17 },
  pending: { color: c.yellow, fontSize: 12, marginTop: 10 },
  scanMsg: { color: c.textMuted, fontSize: 12, marginTop: 8 },
  scanError: { color: c.red, fontSize: 12, marginTop: 6 },
  chart: { gap: 8 },
  chartRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chartLabel: { width: 42, fontSize: 11, color: c.textMuted },
  chartTrack: { flex: 1, height: 14, backgroundColor: c.surface2, borderRadius: 7, overflow: 'hidden' },
  chartBar: { height: '100%', backgroundColor: c.accent, borderRadius: 7 },
  chartValue: { width: 24, fontSize: 11, color: c.text, textAlign: 'right' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
  attentionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
  },
  attentionTitle: { color: c.text, fontSize: 13, fontWeight: '600' },
  attentionScore: { color: c.yellow, fontSize: 13, fontWeight: '700' },
  chevron: { color: c.textFaint, fontSize: 20, marginLeft: -2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowLabel: { flex: 1, color: c.text, fontSize: 13, textTransform: 'capitalize' },
  rowValue: { color: c.textMuted, fontSize: 13, fontWeight: '600' },
})
