// The phone's check that the Supabase project is on the schema it needs, and
// the guard that keeps the phone, the desktop and schema.sql on one number.
const fs = require('fs')
const path = require('path')
const { createChecker } = require('./helpers')
const { REQUIRED_CLOUD_SCHEMA, schemaNotice, readSchemaVersion, checkCloudSchema } = require('../src/cloudSchema')
const { check, done } = createChecker()

;(async () => {
  const rpcReturning = result => async () => result

  check('a current project needs nothing', schemaNotice(REQUIRED_CLOUD_SCHEMA), null)
  check('a newer project needs nothing', schemaNotice(REQUIRED_CLOUD_SCHEMA + 1), null)
  check('an older project is told to re-run schema.sql', /re-run|schema\.sql/.test(schemaNotice(REQUIRED_CLOUD_SCHEMA - 1)), true)
  check('and which version it is on', schemaNotice(3).includes('version 3'), true)

  check('the version is read from the project', await readSchemaVersion(rpcReturning({ data: 4, error: null })), 4)
  check('a project without the version function predates it',
    await readSchemaVersion(rpcReturning({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.hiro_schema_version' } })), null)
  check('a project that predates the function gets the notice',
    /out of date/.test(await checkCloudSchema(rpcReturning({ data: null, error: { code: '42883', message: 'function does not exist' } }))), true)

  // A flaky connection must never read as an old project.
  check('a server error is not a notice', await checkCloudSchema(rpcReturning({ data: null, error: { code: '500', message: 'upstream timeout' } })), null)
  check('a network failure is not a notice', await checkCloudSchema(async () => { throw new Error('Network request failed') }), null)
  check('a garbled answer is not a notice', await checkCloudSchema(rpcReturning({ data: 'x', error: null })), null)

  // One number in three places: bump them together.
  const root = path.join(__dirname, '..', '..')
  const desktop = fs.readFileSync(path.join(root, 'web', 'electron', 'services', 'cloudSync.js'), 'utf8')
  const sql = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8')
  const desktopVersion = Number((desktop.match(/const REQUIRED_CLOUD_SCHEMA = (\d+)/) || [])[1])
  const sqlVersion = Number((sql.match(/hiro_schema_version\(\)[\s\S]*?select (\d+)/) || [])[1])
  check('the phone needs the same schema version as the desktop', REQUIRED_CLOUD_SCHEMA, desktopVersion)
  check('which is the version schema.sql installs', REQUIRED_CLOUD_SCHEMA, sqlVersion)

  done()
})().catch((err) => { console.error(err); process.exitCode = 1 })
