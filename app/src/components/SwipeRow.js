// A list row that slides left to reveal quick actions.
//
// Built on the core PanResponder and Animated rather than
// react-native-gesture-handler: one row type needs it, and a native gesture
// library (with its own config plugin and root-view wrapper) is a lot of
// surface to add for that.
//
// Whether the row is open is owned by the list, not the row, so that opening
// one row closes whichever other one was open — two rows hanging open at once
// is how a tap lands on the wrong application's "Rejected".
//
// Swiping is never the only way in. The list also offers the same actions on a
// long press and as accessibility actions, because a gesture nobody has been
// told about is a gesture most people never find, and one a screen reader
// cannot perform at all.

import { useRef, useEffect, useMemo } from 'react'
import { View, Text, TouchableOpacity, Animated, PanResponder, StyleSheet } from 'react-native'
import { threshold } from '../haptics'

const ACTION_WIDTH = 78

export default function SwipeRow({ actions, open, onOpen, onClose, style, children }) {
  const total = (actions?.length || 0) * ACTION_WIDTH
  const x = useRef(new Animated.Value(0)).current
  // Read by the responder, which is created once and would otherwise close over
  // the first render's props.
  const state = useRef({ open, total, onOpen, onClose, start: 0, crossed: false })
  state.current.open = open
  state.current.total = total
  state.current.onOpen = onOpen
  state.current.onClose = onClose

  useEffect(() => {
    Animated.spring(x, {
      toValue: open ? -total : 0,
      useNativeDriver: true,
      bounciness: 0,
      speed: 18,
    }).start()
  }, [open, total, x])

  const responder = useMemo(() => PanResponder.create({
    // Only claim clearly horizontal drags, so the list still scrolls when a
    // vertical flick starts on a row.
    onMoveShouldSetPanResponder: (_, g) =>
      state.current.total > 0 && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderGrant: () => {
      state.current.start = state.current.open ? -state.current.total : 0
      state.current.crossed = state.current.open
    },
    onPanResponderMove: (_, g) => {
      const { start, total: t } = state.current
      let next = start + g.dx
      // Resist past fully open, and never move right of closed.
      if (next < -t) next = -t + (next + t) / 3
      if (next > 0) next = 0
      x.setValue(next)
      const past = next < -t / 2
      if (past !== state.current.crossed) {
        state.current.crossed = past
        if (past) threshold()
      }
    },
    onPanResponderRelease: (_, g) => {
      const { start, total: t } = state.current
      const shouldOpen = start + g.dx < -t / 2 || g.vx < -0.5
      const next = g.vx > 0.5 ? false : shouldOpen
      // Snap even when the prop is unchanged, since the drag moved the row
      // away from where the effect last put it.
      Animated.spring(x, { toValue: next ? -t : 0, useNativeDriver: true, bounciness: 0, speed: 18 }).start()
      if (next) state.current.onOpen?.()
      else state.current.onClose?.()
    },
    onPanResponderTerminate: () => {
      Animated.spring(x, {
        toValue: state.current.open ? -state.current.total : 0, useNativeDriver: true, bounciness: 0,
      }).start()
    },
    // Keep the row once it has it: the list trying to take over mid-swipe is
    // what leaves a row stuck half open.
    onPanResponderTerminationRequest: () => false,
  }), [x])

  if (!total) return <View style={style}>{children}</View>

  return (
    <View style={[styles.wrap, style]}>
      <View
        style={[styles.actions, { width: total }]}
        // Hidden while closed so a screen reader does not walk into buttons
        // that are behind the row; the row itself exposes the same actions.
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
        accessibilityElementsHidden={!open}
      >
        {actions.map(a => (
          <TouchableOpacity
            key={a.key}
            style={[styles.action, { backgroundColor: a.color }]}
            onPress={a.onPress}
            accessibilityRole="button"
            accessibilityLabel={a.accessibilityLabel || a.label}
          >
            <Text style={styles.actionText} numberOfLines={2}>{a.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Animated.View style={{ transform: [{ translateX: x }] }} {...responder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  actions: { position: 'absolute', right: 0, top: 0, bottom: 0, flexDirection: 'row' },
  action: { width: ACTION_WIDTH, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  actionText: { color: '#fff', fontSize: 12, fontWeight: '700', textAlign: 'center' },
})
