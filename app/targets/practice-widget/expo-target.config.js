// The iOS Practice widget (WidgetKit), built by @bacons/apple-targets during
// `expo prebuild` / EAS Build. app.config.js only turns the plugin on when the
// package is installed and APPLE_TEAM_ID is set, so Android builds and iOS
// builds without a team are unaffected. See ../../README.md → iOS widget.
//
// The app writes a counts-only summary (src/practice.js widgetSummary) to the
// shared App Group; PracticeWidget.swift words it for the phone's own today,
// the same way the Android widget does (widgetView).

/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'widget',
  name: 'HiroPractice',
  displayName: 'Hiro practice',
  deploymentTarget: '17.0',
  entitlements: {
    'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
  },
  colors: {
    $accent: { light: '#5b63e6', dark: '#6d75f6' },
    $widgetBackground: { light: '#ffffff', dark: '#161925' },
  },
})
