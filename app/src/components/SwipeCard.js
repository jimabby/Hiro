// A practice card that can be swiped to rate it, once the answer is showing:
// right for Good, left for Again (src/practice.js swipeRating).
//
// Built on the core PanResponder and Animated, like SwipeRow, and for the same
// reasons. Only clearly horizontal drags are claimed, so a long answer still
// scrolls. A drag far enough slides the card off and rates it; anything less
// springs back. "Good" or "Again" fades in on the side the card is moving
// towards, and the phone ticks as the drag crosses the line, so the user knows
// before letting go.
//
// Swiping is never the only way: the rating buttons stay, and the card offers
// both ratings as accessibility actions for a screen reader.

import { useRef, useMemo, useEffect, useState } from 'react'
import { View, Animated, PanResponder, StyleSheet } from 'react-native'
import { threshold } from '../haptics'
import { swipeRating, swipeProgress, SWIPE_RATINGS } from '../practice'

export default function SwipeCard({ enabled, onRate, style, colors, children }) {
  const x = useRef(new Animated.Value(0)).current
  const [width, setWidth] = useState(0)
  const [hint, setHint] = useState(null) // 'good' | 'again' while dragging
  // Read by the responder, which is created once.
  const state = useRef({ enabled, onRate, width, crossed: false })
  state.current.enabled = enabled
  state.current.onRate = onRate
  state.current.width = width

  // A new card (or the answer hidden again) starts centred.
  useEffect(() => { if (!enabled) { x.setValue(0); setHint(null) } }, [enabled, x])

  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) =>
      state.current.enabled && Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.8,
    onPanResponderGrant: () => { state.current.crossed = false },
    onPanResponderMove: (_, g) => {
      x.setValue(g.dx)
      const counts = swipeProgress(g.dx, state.current.width) >= 1
      setHint(g.dx > 0 ? SWIPE_RATINGS.right : g.dx < 0 ? SWIPE_RATINGS.left : null)
      if (counts !== state.current.crossed) {
        state.current.crossed = counts
        if (counts) threshold()
      }
    },
    onPanResponderRelease: (_, g) => {
      const rating = swipeRating(g.dx, g.vx, state.current.width)
      if (!rating) {
        Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 6, speed: 16 }).start()
        setHint(null)
        return
      }
      const off = (state.current.width || 400) * (g.dx > 0 ? 1.2 : -1.2)
      Animated.timing(x, { toValue: off, duration: 160, useNativeDriver: true }).start(async () => {
        try {
          await state.current.onRate?.(rating)
        } finally {
          // The next card normally replaces this one; if the rating failed the
          // same card is still here, so bring it back.
          x.setValue(0)
          setHint(null)
        }
      })
    },
    onPanResponderTerminate: () => {
      Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start()
      setHint(null)
    },
    // Keep the card once a horizontal drag has it, or the scroll view takes
    // over halfway and the card is left stranded off-centre.
    onPanResponderTerminationRequest: () => false,
  }), [x])

  const rotate = x.interpolate({ inputRange: [-300, 0, 300], outputRange: ['-6deg', '0deg', '6deg'], extrapolate: 'clamp' })
  const goodOpacity = x.interpolate({ inputRange: [0, Math.max(1, width / 3)], outputRange: [0, 1], extrapolate: 'clamp' })
  const againOpacity = x.interpolate({ inputRange: [-Math.max(1, width / 3), 0], outputRange: [1, 0], extrapolate: 'clamp' })

  return (
    <Animated.View
      {...(enabled ? responder.panHandlers : {})}
      onLayout={e => setWidth(e.nativeEvent.layout.width)}
      style={[style, { transform: [{ translateX: x }, { rotate }] }]}
      accessibilityActions={enabled ? [{ name: 'good', label: 'Rate Good' }, { name: 'again', label: 'Rate Again' }] : undefined}
      onAccessibilityAction={e => { if (enabled) onRate?.(e.nativeEvent.actionName) }}>
      {children}
      {enabled && hint && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Animated.Text style={[styles.stamp, styles.stampLeft, { color: colors.accent, borderColor: colors.accent, opacity: goodOpacity }]}>Good</Animated.Text>
          <Animated.Text style={[styles.stamp, styles.stampRight, { color: colors.red, borderColor: colors.red, opacity: againOpacity }]}>Again</Animated.Text>
        </View>
      )}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  stamp: {
    position: 'absolute', top: 18, fontSize: 18, fontWeight: '800', letterSpacing: 1,
    borderWidth: 2, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, overflow: 'hidden',
  },
  // Good shows on the left as the card moves right (towards its side), and
  // Again on the right as it moves left.
  stampLeft: { left: 16, transform: [{ rotate: '-8deg' }] },
  stampRight: { right: 16, transform: [{ rotate: '8deg' }] },
})
