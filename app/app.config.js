const base = require('./app.json').expo

// The iOS Practice widget (targets/practice-widget) needs @bacons/apple-targets
// and an Apple Developer team to sign the extension. It is switched on only
// when both are present, so Android builds, and iOS builds without a team,
// stay exactly as they were. See README.md → iOS widget.
const IOS_APP_GROUP = 'group.com.cessleigh.hiro'

function appleTargetsInstalled() {
  try {
    require.resolve('@bacons/apple-targets/app.plugin')
    return true
  } catch {
    return false
  }
}

function withIosWidget(config) {
  const teamId = process.env.APPLE_TEAM_ID
  if (!teamId || !appleTargetsInstalled()) return config
  return {
    ...config,
    ios: {
      ...config.ios,
      appleTeamId: teamId,
      entitlements: {
        ...(config.ios?.entitlements || {}),
        'com.apple.security.application-groups': [IOS_APP_GROUP],
      },
    },
    plugins: [...(config.plugins || []), '@bacons/apple-targets'],
  }
}

module.exports = () => withIosWidget({
  ...base,
  extra: {
    ...(base.extra || {}),
    eas: process.env.EXPO_PUBLIC_EAS_PROJECT_ID
      ? { ...(base.extra?.eas || {}), projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID }
      : base.extra?.eas,
  },
})

module.exports.IOS_APP_GROUP = IOS_APP_GROUP
