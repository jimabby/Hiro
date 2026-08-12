const { spawnSync } = require('child_process')
const path = require('path')

const required = [
  'EXPO_PUBLIC_EAS_PROJECT_ID',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
]
const missing = required.filter(name => !String(process.env[name] || '').trim())
if (missing.length) {
  console.error(`Missing release environment: ${missing.join(', ')}`)
  process.exit(1)
}

const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
const command = process.platform === 'win32' ? process.execPath : 'npx'
const args = process.platform === 'win32'
  ? [npxCli, 'expo', 'config', '--type', 'public']
  : ['expo', 'config', '--type', 'public']
const result = spawnSync(command, args, {
  encoding: 'utf8',
  env: process.env,
})
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'Expo configuration validation failed.\n')
  process.exit(result.status || 1)
}
console.log('Mobile release configuration is complete.')
