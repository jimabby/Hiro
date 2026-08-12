const { stub, service, createChecker } = require('./helpers')

const events = []
const claimed = new Set()
let backupCalls = 0
const cfg = { setupComplete: true, enableContactReminders: true, enableBackupDrills: true }
stub({
  './config': { load: () => cfg, update: () => cfg, CONFIG_DIR: '/tmp/hiro-safety-test' },
  './database': {
    getDueContacts: () => [{ id: 3, name: 'Alex', email: 'alex@example.com', company: 'Example', next_action_at: '2026-01-01' }],
    claimPushKey: key => { if (claimed.has(key)) return false; claimed.add(key); return true },
    maybeBackup: () => { backupCalls++; return { success: true } },
    drillBackups: () => ({ success: true, checked: 2, failed: 0, checkedAt: new Date().toISOString() }),
    getBackupDrillStatus: () => null,
  },
  './email': {}, './applicator': { isBusy: () => false, cancel: () => {} },
  './webhooks': { send: async () => {} }, './push': {}, './calendarSync': {},
  './cloudSync': { updateScanStatus: async () => {} }, './logger': { append: () => {} },
  'node-cron': { schedule: () => ({ destroy: () => {} }) },
})

const scheduler = service('scheduler.js')
const { check, done } = createChecker()
const win = { isDestroyed: () => false, isFocused: () => true, webContents: { send: (_, data) => events.push(data) } }
scheduler.restart(win)

check('contact check reports due count', scheduler.runContactReminders().due, 1)
check('due contact reaches renderer', events.filter(e => e.type === 'contact-reminder').length, 1)
scheduler.runContactReminders()
check('same contact is notified only once per day', events.filter(e => e.type === 'contact-reminder').length, 1)
check('backup recovery drill succeeds', scheduler.runBackupDrill().success, true)
check('drill creates or refreshes a backup first', backupCalls, 1)
check('drill result reaches renderer', events.some(e => e.type === 'backup-drill'), true)
scheduler.stop({ abortRun: false })
done()
