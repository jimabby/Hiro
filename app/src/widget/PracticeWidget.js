// The Practice home-screen widget (Android). Drawn by react-native-android-widget
// from plain data, in the app's own colours for the phone's light or dark mode.
// Tapping anywhere opens the Practice tab (hiro://practice, see App.js).

import { FlexWidget, TextWidget } from 'react-native-android-widget'
import { palettes } from '../theme'

export const WIDGET_NAME = 'Practice'

function Body({ view, colors }) {
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: 'hiro://practice' }}
      accessibilityLabel={`Hiro practice. ${view.headline}. ${view.detail}`}
      style={{
        height: 'match_parent', width: 'match_parent', flexDirection: 'column', justifyContent: 'space-between',
        backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: colors.border, padding: 14,
      }}>
      <TextWidget text="Hiro · Practice" style={{ fontSize: 12, color: colors.accent, fontWeight: '600' }} />
      <TextWidget text={view.headline} maxLines={2} truncate="END" style={{ fontSize: 20, fontWeight: '700', color: colors.text }} />
      <TextWidget text={view.detail} maxLines={2} truncate="END" style={{ fontSize: 12, color: colors.textMuted }} />
    </FlexWidget>
  )
}

// Both looks, so the launcher can switch with the system theme without asking
// the app to redraw.
export function practiceWidget(view) {
  return {
    light: <Body view={view} colors={palettes.light} />,
    dark: <Body view={view} colors={palettes.dark} />,
  }
}
