// The last few weeks of practice, one square a day, Monday at the top: the
// same calendar as the desktop's Insights tab, cut to fit a phone. One hue,
// darker for busier days. A screen reader hears the summary line instead of
// 112 squares.

import { View, Text, StyleSheet } from 'react-native'
import { calendarTail, calendarShade } from '../practice'

const SHADE_OPACITY = [1, 0.35, 0.55, 0.78, 1]

export default function PracticeCalendar({ calendar, colors, weeks = 16 }) {
  const cal = calendarTail(calendar, weeks)
  if (!cal) return null
  const columns = Array.from({ length: cal.weeks }, (_, w) => cal.counts.slice(w * 7, w * 7 + 7))
  const summary = `${cal.activeDays} practice day${cal.activeDays === 1 ? '' : 's'} in the last ${cal.weeks} weeks · ${cal.total} card${cal.total === 1 ? '' : 's'} rated`
  return (
    <View style={styles.wrap} accessible accessibilityRole="summary" accessibilityLabel={summary}>
      <View style={styles.grid} importantForAccessibility="no-hide-descendants">
        {columns.map((days, w) => (
          <View key={w} style={styles.column}>
            {days.map((count, d) => {
              const level = calendarShade(count, cal.max)
              if (count < 0) return <View key={d} style={styles.cell} />
              return (
                <View key={d} style={[
                  styles.cell,
                  level === 0
                    ? { backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }
                    : { backgroundColor: colors.accent, opacity: SHADE_OPACITY[level] },
                ]} />
              )
            })}
          </View>
        ))}
      </View>
      <Text style={[styles.caption, { color: colors.textMuted }]}>{summary}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { marginTop: 16, alignItems: 'center' },
  grid: { flexDirection: 'row', gap: 3 },
  column: { gap: 3 },
  cell: { width: 12, height: 12, borderRadius: 2 },
  caption: { fontSize: 12, marginTop: 8, textAlign: 'center' },
})
