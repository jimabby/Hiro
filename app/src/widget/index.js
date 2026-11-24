// The Practice widget's data: kept by the app, read by the widget.
//
// The widget's task runs headless, without the app's pairing keys or cloud
// session, so it never contacts the desktop. Instead the app saves a summary of
// the day (counts only; see widgetSummary) each time it loads practice, and
// asks Android to redraw. The widget words that summary for the phone's own
// today, so it stays truthful overnight: a summary from yesterday reads "New
// cards today", not "Done for today".
//
// Android only: on iOS every call here is a quiet no-op (the library itself
// stands in a do-nothing module there). The native half arrives with the app
// build, so a phone needs a new build from EAS before the widget appears.

import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { registerWidgetTaskHandler, requestWidgetUpdate } from 'react-native-android-widget'
import { widgetSummary, widgetView } from '../practice'
import { WIDGET_NAME, practiceWidget } from './PracticeWidget'

const KEY = 'hiro.practiceWidget.v1'

async function readSummary() {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

const supported = () => Platform.OS === 'android'

// After the Practice tab loads or changes the day's data.
export async function updatePracticeWidget(data) {
  if (!supported()) return
  const summary = widgetSummary(data)
  if (!summary) return
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(summary))
    await requestWidgetUpdate({ widgetName: WIDGET_NAME, renderWidget: () => practiceWidget(widgetView(summary)) })
  } catch {
    // A widget that cannot redraw is not worth an error on the practice screen.
  }
}

// Forget the summary (signing out): the widget goes back to its neutral text.
export async function clearPracticeWidget() {
  if (!supported()) return
  try {
    await AsyncStorage.removeItem(KEY)
    await requestWidgetUpdate({ widgetName: WIDGET_NAME, renderWidget: () => practiceWidget(widgetView(null)) })
  } catch { /* nothing to redraw */ }
}

// Android calls this when a widget is added, resized, or on its update period
// (every 30 minutes, set in app.json), so the wording follows the clock even
// when the app has not been opened.
export async function practiceWidgetTask({ widgetInfo, widgetAction, renderWidget }) {
  if (widgetInfo.widgetName !== WIDGET_NAME || widgetAction === 'WIDGET_DELETED') return
  renderWidget(practiceWidget(widgetView(await readSummary())))
}

export function registerPracticeWidget() {
  if (supported()) registerWidgetTaskHandler(practiceWidgetTask)
}
