// Sending a job link to the desktop's Needs Attention list — from the share
// sheet, a hiro://import link, or the clipboard. POSTs to /api/import-job, the
// route the browser extension uses (web/electron/services/mobileApi.js).
//
// Same rules as a scan: only an unreachable desktop means "hold it for later";
// a refusal is reported as one. See src/requestErrors.js.
import { classifyError, messageFor } from './requestErrors'
import { enqueueImport } from './scanQueue'
import { randomKey } from './secureProtocol'

// Resolves to { status, message }, status one of:
//   'imported'  — on the desktop now
//   'queued'    — desktop unreachable; held and sent on the next refresh
//   'auth'      — the desktop no longer accepts this phone; re-pair
//   'failed'    — refused (not a job URL, a cloud connection), with the reason
export async function importJobLink(client, job) {
  if (!client?.canImport || !client.importJob) {
    return { status: 'failed', message: 'Importing a job needs this phone paired with the desktop on your local network.' }
  }
  const idempotencyKey = randomKey()
  try {
    await client.importJob(job, { idempotencyKey })
    return { status: 'imported', message: 'Added to Needs Attention on the desktop.' }
  } catch (err) {
    const kind = classifyError(err)
    if (kind === 'offline') {
      try {
        await enqueueImport({ ...job, idempotencyKey }, client)
        return { status: 'queued', message: 'The desktop is out of reach, so the link was saved and will be sent when it is back.' }
      } catch (queueError) {
        return { status: 'failed', message: `The link was not saved: ${queueError.message}` }
      }
    }
    if (kind === 'auth') return { status: 'auth', message: err.message || 'This phone needs to be paired again.' }
    return { status: 'failed', message: err?.scope ? messageFor(err) : (err.message || 'The desktop did not accept the link.') }
  }
}
