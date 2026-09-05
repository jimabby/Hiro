// Offers, on the phone.
//
// Every other screen here answers "what happened". This one exists for the few
// days where the answer is already yes and the question is *which* yes — and it
// is on the phone for one reason above the rest: `respond_by` is the only
// externally-imposed deadline anywhere in Hiro. Every other date the apps track
// is one Hiro chose, or one that is advisory. Miss a respond_by and the offer is
// gone. Until now that date could only be read on the machine at home.
//
// Read-only, deliberately. Accepting, declining and the negotiation draft stay
// on the desktop: those are not decisions to take one-handed on a train, and a
// mistap here is not recoverable the way a mistyped note is.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View, Text, ScrollView, RefreshControl, StyleSheet, TouchableOpacity,
} from 'react-native'
import { radius, radiusLg, useTheme } from '../theme'

// How the deadline is coloured. An offer with two days left and one with three
// weeks left must not look the same — that is the whole premise of the page.
function urgency(days, c) {
  if (days == null) return { color: c.textMuted, label: 'No deadline set' }
  if (days < 0) return { color: c.textFaint, label: 'Deadline passed' }
  if (days === 0) return { color: c.red, label: 'Respond today' }
  if (days === 1) return { color: c.red, label: '1 day left' }
  if (days <= 3) return { color: c.red, label: `${days} days left` }
  if (days <= 7) return { color: c.yellow, label: `${days} days left` }
  return { color: c.textMuted, label: `${days} days left` }
}

// Money, at a glance. Full precision belongs on the desktop; here the point is
// that two offers can be compared in the two seconds someone actually spends.
function money(amount, currency) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  const short = n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))
  return currency ? `${short} ${currency}` : short
}

const DECISION_LABELS = {
  considering: 'Considering',
  accepted: 'Accepted',
  declined: 'Declined',
}

export default function OffersScreen({ client }) {
  // Palette and stylesheet follow the phone's appearance setting. Named
  // `colors` so every inline reference below reads unchanged.
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const [board, setBoard] = useState(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  // Which cards have their detail open. Collapsed by default: the deadline and
  // the number are what the screen is for, and everything else is a second tap.
  const [expanded, setExpanded] = useState({})

  const load = useCallback(async () => {
    try {
      setBoard(await client.getOffers())
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

  const offers = board?.offers || []
  const live = offers.filter(o => o.decision === 'considering')
  const settled = offers.filter(o => o.decision !== 'considering')

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      <Text style={styles.title} accessibilityRole="header">Offers</Text>

      {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}

      {board && offers.length === 0 && !error && (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No offers yet</Text>
          <Text style={styles.emptyBody}>
            An application you move to Offer on the desktop shows up here, with whatever
            you have filled in about it — and its deadline, if there is one.
          </Text>
        </View>
      )}

      {/* The summary the page leads with: how many decisions are open, and what
          expires first. Only shown when there is more than one thing to weigh —
          a single offer is its own summary. */}
      {live.length > 1 && (
        <View style={styles.summary}>
          <View style={styles.summaryCell}>
            <Text style={styles.summaryValue}>{live.length}</Text>
            <Text style={styles.summaryLabel}>open</Text>
          </View>
          {board.best != null && (
            <View style={styles.summaryCell}>
              <Text style={styles.summaryValue}>{money(board.best, live[0]?.currency)}</Text>
              <Text style={styles.summaryLabel}>best</Text>
            </View>
          )}
          {board.spread != null && (
            <View style={styles.summaryCell}>
              <Text style={styles.summaryValue}>{money(board.spread, live[0]?.currency)}</Text>
              <Text style={styles.summaryLabel}>spread</Text>
            </View>
          )}
        </View>
      )}

      {live.map(o => (
        <OfferCard
          key={o.id}
          offer={o}
          open={!!expanded[o.id]}
          onToggle={() => setExpanded(e => ({ ...e, [o.id]: !e[o.id] }))}
        />
      ))}

      {settled.length > 0 && (
        <>
          <Text style={styles.sectionHead}>Settled</Text>
          {settled.map(o => (
            <OfferCard
              key={o.id}
              offer={o}
              settled
              open={!!expanded[o.id]}
              onToggle={() => setExpanded(e => ({ ...e, [o.id]: !e[o.id] }))}
            />
          ))}
        </>
      )}

      {offers.length > 0 && (
        <Text style={styles.footnote}>
          Accepting, declining and drafting a negotiation stay on the desktop.
        </Text>
      )}
    </ScrollView>
  )
}

function OfferCard({ offer, open, onToggle, settled = false }) {
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const u = urgency(offer.daysToRespond, colors)
  const hasDetail = !!(offer.pros || offer.cons || offer.notes || offer.equity
    || offer.location || offer.remote || offer.start_date || offer.metaPending)

  return (
    <View style={[styles.card, settled && styles.cardSettled]}>
      {/* The deadline rail. Colour alone would fail anyone who cannot tell red
          from amber, so the words beside it say the same thing. */}
      {!settled && <View style={[styles.rail, { backgroundColor: u.color }]} />}

      <TouchableOpacity
        activeOpacity={hasDetail ? 0.7 : 1}
        onPress={hasDetail ? onToggle : undefined}
        accessibilityRole={hasDetail ? 'button' : 'text'}
        accessibilityLabel={
          `${offer.job_title || 'Offer'} from ${offer.company || 'an employer'}.`
          + ` ${settled ? DECISION_LABELS[offer.decision] || offer.decision : u.label}.`
          + (offer.comparableComp != null
            ? ` ${offer.compIsAdvertised ? 'Advertised around' : 'Total'} ${money(offer.comparableComp, offer.currency)}.`
            : '')
        }
        accessibilityHint={hasDetail ? (open ? 'Hides the detail' : 'Shows the detail') : undefined}
        accessibilityState={{ expanded: hasDetail ? open : undefined }}
      >
        <View style={styles.cardHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.role} numberOfLines={2}>{offer.job_title || 'Offer'}</Text>
            <Text style={styles.company} numberOfLines={1}>{offer.company || 'Unknown company'}</Text>
          </View>
          <View style={styles.compBlock}>
            <Text style={[styles.comp, offer.compIsAdvertised && styles.compAdvertised]}>
              {offer.comparableComp != null ? money(offer.comparableComp, offer.currency) : '—'}
            </Text>
            {/* Never dressed up as an offer figure. Presenting an advertised
                range as though somebody had put it in writing is the one failure
                on this screen that would actively mislead. */}
            <Text style={styles.compKind}>
              {offer.comparableComp == null ? 'not entered'
                : offer.compIsAdvertised ? 'advertised' : 'total comp'}
            </Text>
          </View>
        </View>

        <View style={styles.metaRow}>
          {settled ? (
            <Text style={styles.settledTag}>{DECISION_LABELS[offer.decision] || offer.decision}</Text>
          ) : (
            <Text style={[styles.deadline, { color: u.color }]}>
              {u.label}{offer.respond_by ? ` · by ${offer.respond_by}` : ''}
            </Text>
          )}
          {offer.excitement != null && (
            <Text style={styles.excitement} accessibilityLabel={`Excitement ${offer.excitement} out of 5`}>
              {'★'.repeat(Math.max(0, Math.min(5, offer.excitement)))}
              <Text style={styles.excitementOff}>
                {'★'.repeat(5 - Math.max(0, Math.min(5, offer.excitement)))}
              </Text>
            </Text>
          )}
          {hasDetail && <Text style={styles.chevron}>{open ? '▲' : '▼'}</Text>}
        </View>
      </TouchableOpacity>

      {open && hasDetail && (
        <View style={styles.detail}>
          {/* The deadline, the decision and the headline number are stored in
              the clear so this screen can sort and colour before it decrypts
              anything. Everything else is inside the envelope — so when this
              device cannot open it, say that, rather than showing an offer that
              looks like nobody filled it in. */}
          {offer.metaPending && (
            <Text style={styles.locked}>
              The rest of this offer is encrypted and could not be opened on this phone.
              Sign in again to re-derive the key, or read it on the desktop.
            </Text>
          )}
          {!!offer.start_date && <Detail label="Starts" value={offer.start_date} />}
          {!!offer.location && <Detail label="Location" value={offer.location} />}
          {!!offer.remote && <Detail label="Remote" value={offer.remote} />}
          {!!offer.equity && <Detail label="Equity" value={offer.equity} />}
          {!!offer.pros && <Detail label="For" value={offer.pros} />}
          {!!offer.cons && <Detail label="Against" value={offer.cons} />}
          {!!offer.notes && <Detail label="Notes" value={offer.notes} />}
        </View>
      )}
    </View>
  )
}

function Detail({ label, value }) {
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  return (
    <View style={styles.detailRow} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  )
}

// Rebuilt per palette — see useTheme() in ../theme.
const makeStyles = (c) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  content: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 22, fontWeight: '700', color: c.text, marginBottom: 12 },
  error: { color: c.red, fontSize: 13, marginBottom: 10 },

  empty: {
    borderWidth: 1, borderColor: c.border, borderRadius: radiusLg,
    padding: 20, marginTop: 8,
  },
  emptyTitle: { color: c.text, fontSize: 15, fontWeight: '600', marginBottom: 6 },
  emptyBody: { color: c.textMuted, fontSize: 13, lineHeight: 19 },

  summary: {
    flexDirection: 'row', gap: 1, backgroundColor: c.border,
    borderRadius: radius, overflow: 'hidden', marginBottom: 14,
    borderWidth: 1, borderColor: c.border,
  },
  summaryCell: { flex: 1, backgroundColor: c.surface, paddingVertical: 11, alignItems: 'center' },
  summaryValue: { color: c.text, fontSize: 18, fontWeight: '700' },
  summaryLabel: { color: c.textMuted, fontSize: 11, marginTop: 2 },

  card: {
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
    borderRadius: radius, padding: 14, paddingLeft: 17, marginBottom: 10,
    overflow: 'hidden',
  },
  cardSettled: { opacity: 0.62 },
  rail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },

  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  role: { color: c.text, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  company: { color: c.textMuted, fontSize: 12.5, marginTop: 2 },

  compBlock: { alignItems: 'flex-end', flexShrink: 0 },
  comp: { color: c.text, fontSize: 17, fontWeight: '700' },
  // An advertised figure is quieter than one somebody put in writing.
  compAdvertised: { color: c.textMuted, fontWeight: '600' },
  compKind: { color: c.textFaint, fontSize: 10, marginTop: 1 },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  deadline: { fontSize: 12.5, fontWeight: '600', flex: 1 },
  settledTag: { color: c.textMuted, fontSize: 12.5, fontWeight: '600', flex: 1 },
  excitement: { color: c.yellow, fontSize: 12 },
  excitementOff: { color: c.borderStrong },
  chevron: { color: c.textFaint, fontSize: 10 },

  detail: {
    marginTop: 12, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: c.border, gap: 8,
  },
  locked: { color: c.yellow, fontSize: 12.5, lineHeight: 18 },
  detailRow: { gap: 2 },
  detailLabel: {
    color: c.textFaint, fontSize: 10.5, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  detailValue: { color: c.text, fontSize: 13, lineHeight: 18 },

  sectionHead: {
    color: c.textMuted, fontSize: 11, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.6,
    marginTop: 14, marginBottom: 8,
  },
  footnote: { color: c.textFaint, fontSize: 11.5, marginTop: 14, lineHeight: 16 },
})
