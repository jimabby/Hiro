// The cloud session has to outlive the hour.
//
// The client is built with autoRefreshToken:false, so keeping the access token
// alive is this service's own job. It was not being done: restoreSession ran
// once at launch and was only ever reached again when `user` was falsy, which
// it never became after a successful sign-in. Supabase access tokens last an
// hour and this app is designed to sit in the tray for days, so an hour after
// launch every sync failed with "JWT expired" — and because the failure never
// cleared `user`, the two-minute timer kept firing and kept failing until the
// app was restarted. Phone sync, push notifications and phone-queued scans all
// went with it.

const { stub, service, createChecker } = require('./helpers')

// ── Fake Supabase ─────────────────────────────────────────────────
// The access token is modelled as an expiry the fake enforces: a query issued
// after it lapses fails exactly the way PostgREST does.
let now = 1_000_000_000_000
let refreshCalls = 0
let tokenExpiresAt = 0
let queryErrors = []
// Set to make the refresh itself fail, which is what a revoked or rotated
// refresh token looks like.
let refreshFails = false

const TTL_SECONDS = 3600

function makeQuery() {
  const q = {
    select: () => q, eq: () => q, gte: () => q, in: () => q, not: () => q,
    order: () => q, delete: () => q, range: () => q,
    upsert: () => Promise.resolve({ error: expired() }),
    then(res) { return Promise.resolve({ data: [], error: expired() }).then(res) },
  }
  return q
}

function expired() {
  if (now < tokenExpiresAt) return null
  const error = { message: 'JWT expired', code: 'PGRST301' }
  queryErrors.push(error.message)
  return error
}

stub({
  './config': {
    load: () => ({
      cloudSyncEnabled: true, supabaseUrl: 'https://x.supabase.co',
      supabaseAnonKey: 'k', supabaseRefreshToken: 't',
    }),
    update: () => ({}),
    CONFIG_DIR: '/tmp/hiro-test',
  },
  './database': {
    batch: (fn) => fn(),
    getDirtyApplications: () => [],
    getAllApplicationIds: () => [],
    getAllInterviewEventsForSync: () => [],
    getAttentionJobs: () => [],
    getOffers: () => ({ offers: [] }),
    countApplications: () => 0,
    getTombstones: () => [],
    clearTombstones: () => {},
    countSyncConflicts: () => 0,
  },
  '@supabase/supabase-js': {
    createClient: () => ({
      auth: {
        refreshSession: async () => {
          refreshCalls++
          if (refreshFails) return { data: {}, error: { message: 'Invalid Refresh Token' } }
          tokenExpiresAt = now + TTL_SECONDS * 1000
          return {
            data: {
              session: { refresh_token: 't', expires_at: Math.floor(tokenExpiresAt / 1000) },
              user: { id: 'u1' },
            },
            error: null,
          }
        },
      },
      from: () => makeQuery(),
    }),
  },
})

const cloudSync = service('cloudSync.js')
const { check, done } = createChecker()

// Drive the clock rather than waiting on it.
const realNow = Date.now
Date.now = () => now

;(async () => {
  // ── expiryOf reads whichever field the session carries. ──────────
  check('expires_at is read as seconds', cloudSync.expiryOf({ expires_at: 1700 }), 1_700_000)
  check('expires_in is read as a duration', cloudSync.expiryOf({ expires_in: 60 }), now + 60_000)
  // Neither field: assume the provider default rather than "never expires".
  check('a session with no expiry is not immortal', cloudSync.expiryOf({}), now + 3_600_000)

  // ── First contact signs in. ──────────────────────────────────────
  cloudSync._resetSession()
  refreshCalls = 0; tokenExpiresAt = 0; queryErrors = []
  check('session established', await cloudSync.ensureSession(), true)
  check('one refresh so far', refreshCalls, 1)

  // ── A live token is reused rather than re-fetched. ───────────────
  now += 10 * 60 * 1000 // ten minutes later
  check('still valid', await cloudSync.ensureSession(), true)
  check('no needless refresh', refreshCalls, 1)

  // ── Past the hour, the token is renewed BEFORE it is used. ───────
  // This is the whole bug: previously `user` was still set, so this path was
  // never taken and the request went out with a dead token.
  now += 55 * 60 * 1000 // 65 minutes in — the token lapsed five minutes ago
  check('expired session is renewed', await cloudSync.ensureSession(), true)
  check('a second refresh happened', refreshCalls, 2)

  // ── The refresh margin means a sync never starts on a token that
  //    will die mid-run. ─────────────────────────────────────────────
  refreshCalls = 0
  now = tokenExpiresAt - 60 * 1000 // one minute of life left
  await cloudSync.ensureSession()
  check('a nearly-dead token is refreshed early', refreshCalls, 1)

  // ── A full sync across the expiry boundary makes no expired call. ─
  cloudSync._resetSession()
  refreshCalls = 0; tokenExpiresAt = 0; queryErrors = []
  await cloudSync.sync()
  check('first sync ran cleanly', queryErrors, [])
  now += 2 * 60 * 60 * 1000 // two hours pass with the app left running
  await cloudSync.sync()
  check('a sync two hours later still uses a live token', queryErrors, [])
  check('it refreshed rather than failing', refreshCalls, 2)

  // ── A refresh the server refuses must clear the session, so the
  //    next attempt tries again instead of reusing a dead one. ───────
  refreshFails = true
  now += 2 * 60 * 60 * 1000
  check('a refused refresh reports failure', await cloudSync.ensureSession(), false)
  check('and is retried next time', await cloudSync.ensureSession(), false)
  check('each attempt really re-tried', refreshCalls, 4)
  check('the account no longer reads as signed in', cloudSync.getStatus().signedIn, false)

  Date.now = realNow
  done()
})()
