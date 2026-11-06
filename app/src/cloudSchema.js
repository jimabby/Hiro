// Is the user's Supabase project on the schema this app needs?
//
// The desktop checks hiro_schema_version() before every sync and stops with a
// sentence saying what to do (web/electron/services/cloudSync.js). The phone
// did not check at all: its reads degrade on an older schema (see COLUMN_TIERS
// in supabase.js), but the writes a newer schema added — changing or
// cancelling a phone command, version 4 — failed with raw database errors that
// said nothing about re-running schema.sql.
//
// So the phone asks once per session and shows a notice. It never blocks: the
// lists still work, and the notice says exactly what fixes the rest.
//
// Kept free of React Native imports so it can be tested under plain Node.
// Bump together with REQUIRED_CLOUD_SCHEMA in cloudSync.js and the function in
// supabase/schema.sql — test/cloud-schema.test.js holds the three together.
export const REQUIRED_CLOUD_SCHEMA = 4

// The notice for a project on `version` (null: the version function itself is
// missing, so the project predates it), or null when nothing needs doing.
export function schemaNotice(version) {
  if (version != null && version >= REQUIRED_CLOUD_SCHEMA) return null
  return `Your cloud project's database is out of date (version ${version ?? 'unknown'}; this app needs ${REQUIRED_CLOUD_SCHEMA}). `
    + 'Some actions, like changing a request you sent to the desktop, will fail until it is updated. '
    + 'In the Supabase SQL editor, paste the whole of supabase/schema.sql and run it. Re-running it is safe.'
}

// The project's schema version via `rpc` (supabase.rpc bound to the client).
// Returns a number, null when the version function does not exist, or
// undefined when the answer is unknown (offline, server error) — which must
// never produce a notice, or a flaky connection would read as an old project.
export async function readSchemaVersion(rpc) {
  let result
  try {
    result = await rpc('hiro_schema_version')
  } catch {
    return undefined
  }
  const { data, error } = result || {}
  if (error) {
    const missing = error.code === 'PGRST202' || error.code === '42883' || /hiro_schema_version/i.test(String(error.message || ''))
    return missing ? null : undefined
  }
  const version = Number(data)
  return Number.isFinite(version) ? version : undefined
}

// The notice to show for this project, or null. `undefined` (unknown) → null.
export async function checkCloudSchema(rpc) {
  const version = await readSchemaVersion(rpc)
  if (version === undefined) return null
  return schemaNotice(version)
}
