// When the raw password may be retried, and when App Lock covers the screen.
const { createChecker } = require('./helpers')
const { isInvalidCredentials, shouldTryLegacyPassword } = require('../src/legacySignIn')
const { shouldObscure } = require('../src/appLock')
const { check, done } = createChecker()

const invalid = { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' }
check('wrong credentials may be a legacy account', shouldTryLegacyPassword(invalid), true)
check('older GoTrue without a code, by its message', isInvalidCredentials({ status: 400, message: 'Invalid login credentials' }), true)
check('a rate limit never sends the raw password', shouldTryLegacyPassword({ status: 429, code: 'over_request_rate_limit', message: 'Too many requests' }), false)
check('an outage never sends the raw password', shouldTryLegacyPassword({ status: 503, message: 'Service unavailable' }), false)
check('no network never sends the raw password', shouldTryLegacyPassword({ status: 0, name: 'AuthRetryableFetchError', message: 'Network request failed' }), false)
check('a bare 400 is not enough', shouldTryLegacyPassword({ status: 400, message: 'Bad request' }), false)
check('another 400 code is not enough', shouldTryLegacyPassword({ status: 400, code: 'email_not_confirmed', message: 'Invalid login credentials' }), false)
check('an account seen upgraded on this phone never falls back', shouldTryLegacyPassword(invalid, { knownUpgraded: true }), false)
check('no error, no fallback', shouldTryLegacyPassword(null), false)

check('lock on, inactive (iOS app switcher): covered', shouldObscure({ enabled: true, appState: 'inactive' }), true)
check('lock on, background (Android recents): covered', shouldObscure({ enabled: true, appState: 'background' }), true)
check('lock on, active: not covered', shouldObscure({ enabled: true, appState: 'active' }), false)
check('lock off: never covered', shouldObscure({ enabled: false, appState: 'background' }), false)
check('during the Face ID prompt: not covered', shouldObscure({ enabled: true, appState: 'inactive', prompting: true }), false)
done()
