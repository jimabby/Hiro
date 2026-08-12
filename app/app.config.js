const base = require('./app.json').expo
module.exports = () => ({
  ...base,
  extra: {
    ...(base.extra || {}),
    eas: process.env.EXPO_PUBLIC_EAS_PROJECT_ID
      ? { ...(base.extra?.eas || {}), projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID }
      : base.extra?.eas,
  },
})
