// What a failed request means for the queue: only "could not reach it" waits.
const { createChecker } = require('./helpers')
const { classifyError, isRetryable, newIdempotencyKey, messageFor } = require('../src/requestErrors')
const { check, done } = createChecker()

const http = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status }, extra)

check('fetch rejection is offline', classifyError(Object.assign(new TypeError('Network request failed'), { network: true })), 'offline')
check('timeout is offline (the idempotency key makes the retry safe)', classifyError(Object.assign(new Error('Connection timed out'), { timeout: true })), 'offline')
check('supabase network failure, by message, is offline', classifyError(new Error('TypeError: Failed to fetch')), 'offline')
check('401 needs re-pairing', classifyError(http(401, { needsPairing: true })), 'auth')
check('429 lockout is busy, not offline', classifyError(http(429)), 'busy')
check('503 is busy', classifyError(http(503)), 'busy')
check('400 is rejected', classifyError(http(400)), 'rejected')
check('403 is rejected', classifyError(http(403)), 'rejected')
check('an untrustworthy reply is rejected', classifyError(Object.assign(new Error('reply did not match'), { untrusted: true })), 'rejected')
check('a database error is rejected, not queued', classifyError(new Error('permission denied for table scan_requests')), 'rejected')
check('offline and busy are retryable', [isRetryable('offline'), isRetryable('busy')], [true, true])
check('auth and rejected are not', [isRetryable('auth'), isRetryable('rejected')], [false, false])

check('403 with a scope is rejected, never queued', classifyError(http(403, { scope: 'scan' })), 'rejected')
check('scope error names the missing permission', /start scans/.test(messageFor(http(403, { scope: 'scan' }))), true)
check('other errors keep their own message', messageFor(new Error('Boom')), 'Boom')

const k1 = newIdempotencyKey(), k2 = newIdempotencyKey()
check('idempotency keys are unique', k1 !== k2, true)
check('idempotency keys are header-safe', /^[a-z0-9-]+$/.test(k1), true)

done()
