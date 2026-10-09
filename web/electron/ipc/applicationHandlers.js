// IPC for everything that sends, holds or takes back an application: the
// Needs Attention apply paths, the review queue, follow-up drafts, bulk-run
// cancellation and undo for deletes. Moved out of main.js, which had grown to
// nearly two hundred handlers in one file — these share state (the undo slot,
// the review log) and are easiest to reason about together.

const configService = require('../services/config')
const database = require('../services/database')
const applicator = require('../services/applicator')
const emailService = require('../services/email')
const logger = require('../services/logger')
const { makeAskQuestion } = require('../services/askQuestion')
const { makeConfirmSubmit } = require('../services/confirmSubmit')

function registerApplicationHandlers({ ipcMain, scheduler, getWindow }) {
  // ─── Undo for deletes ────────────────────────────────────────────
  //
  // The captured rows stay in the main process and the renderer is handed only a
  // token. Two reasons, and the first is the load-bearing one: "clear all" on a
  // long job search captures every application with its documents, replies and
  // snapshots, and sending that across the IPC boundary and back would move
  // several megabytes through the renderer to undo a click. The second is that
  // the renderer never needs to see it — it needs to offer the button.
  //
  // One slot, not a stack. Undo here means "I did not mean that", which is about
  // the action just taken; a history of undoable deletes invites undoing the
  // wrong one, and the backup system is what answers questions older than the
  // last click.
  const UNDO_TTL_MS = 120000
  // "Delete selected" deletes one row per call, in a loop. Without coalescing,
  // ten rows would leave a buffer holding the tenth and a toast offering to undo
  // "1 application" — the one case where an undo button that lies is worse than
  // no undo button. Deletes arriving in quick succession are therefore treated as
  // the one action the user actually took.
  const UNDO_COALESCE_MS = 5000
  let pendingUndo = null

  function mergeCapture(kind, into, next) {
    if (kind === 'attention') {
      return { attention_jobs: [...(into.attention_jobs || []), ...(next.attention_jobs || [])] }
    }
    const children = { ...into.children }
    for (const [table, rows] of Object.entries(next.children || {})) {
      children[table] = [...(children[table] || []), ...(rows || [])]
    }
    return {
      applications: [...(into.applications || []), ...(next.applications || [])],
      children,
      global: next.global || into.global,
    }
  }

  // The TTL is deliberately longer than the toast that offers it. The toast is
  // the prompt; the window is how long the offer stays honest while the user
  // reads what vanished before deciding. Expiring exactly when the toast fades
  // would make a click on a still-visible button fail.
  function stashUndo(kind, capture, describe) {
    if (!capture) return null
    const coalescing = pendingUndo
      && pendingUndo.kind === kind
      && Date.now() - pendingUndo.startedAt < UNDO_COALESCE_MS

    const merged = coalescing ? mergeCapture(kind, pendingUndo.capture, capture) : capture
    const count = kind === 'attention'
      ? (merged.attention_jobs || []).length
      : (merged.applications || []).length

    pendingUndo = {
      // The token is kept across a coalesce so the toast already on screen still
      // works — it now undoes more than it did when it appeared, which is right.
      token: coalescing ? pendingUndo.token : require('crypto').randomUUID(),
      kind,
      capture: merged,
      label: describe(count),
      startedAt: coalescing ? pendingUndo.startedAt : Date.now(),
      expiresAt: Date.now() + UNDO_TTL_MS,
    }
    return { token: pendingUndo.token, label: pendingUndo.label }
  }

  ipcMain.handle('db:undoDelete', (_, token) => {
    if (!pendingUndo || pendingUndo.token !== token) {
      return { success: false, error: 'There is nothing left to undo.' }
    }
    if (Date.now() > pendingUndo.expiresAt) {
      pendingUndo = null
      return { success: false, error: 'That undo has expired.' }
    }
    const { kind, capture } = pendingUndo
    // Cleared before restoring, not after: a restore that throws half way must
    // not leave a token that can be replayed onto the rows it did manage to put
    // back.
    pendingUndo = null
    try {
      const result = kind === 'attention'
        ? database.restoreAttentionJobs(capture)
        : database.restoreApplications(capture)
      return { success: true, restored: result.restored }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  const describeApplications = (n) => `${n} application${n === 1 ? '' : 's'} deleted`
  const describeAttention = (n) => `${n} job${n === 1 ? '' : 's'} removed`

  ipcMain.handle('db:deleteApplication', (_, id) => {
    const result = database.deleteApplication(id)
    return { ...result, undo: stashUndo('application', result.undo, describeApplications) }
  })
  ipcMain.handle('db:clearAllApplications', () => {
    const result = database.clearAllApplications()
    return { ...result, undo: stashUndo('application', result.undo, describeApplications) }
  })
  ipcMain.handle('db:getAttentionJobs', () => database.getAttentionJobs())
  ipcMain.handle('db:dismissAttention', (_, id) => database.dismissAttentionJob(id))
  ipcMain.handle('db:deleteAttentionJob', (_, id) => {
    const result = database.deleteAttentionJob(id)
    return { ...result, undo: stashUndo('attention', result.undo, describeAttention) }
  })
  ipcMain.handle('db:clearAllAttentionJobs', () => {
    const result = database.clearAllAttentionJobs()
    return { ...result, undo: stashUndo('attention', result.undo, describeAttention) }
  })
  ipcMain.handle('db:getStats', () => database.getStats())

  // ─── IPC: AI Apply from Needs Attention ─────────────────────────
  ipcMain.handle('application:applySkipped', async (_, jobId) => {
    try {
      const saved = configService.load()
      const cfg = { ...saved, askQuestion: makeAskQuestion(getWindow()), confirmSubmit: saved.confirmBeforeSubmit ? makeConfirmSubmit(getWindow()) : undefined }
      const result = await applicator.applySkippedJob(jobId, cfg, (msg) => {
        logger.append(`[skipped-apply] ${msg}`)
        if (getWindow() && !getWindow().isDestroyed()) {
          getWindow().webContents.send('skipped:apply-log', msg)
        }
      })
      return result
    } catch (err) {
      return { success: false, reason: err.message }
    } finally {
      scheduler.processQueue().catch(() => {})
    }
  })

  ipcMain.handle('attention:apply', async (_, jobId) => {
    try {
      const saved = configService.load()
      const cfg = { ...saved, askQuestion: makeAskQuestion(getWindow()), confirmSubmit: saved.confirmBeforeSubmit ? makeConfirmSubmit(getWindow()) : undefined }
      const result = await applicator.applyAttentionJob(jobId, cfg, attentionLog)
      return result
    } catch (err) {
      return { success: false, reason: err.message }
    } finally {
      // A manual apply blocks queued scans (it holds the applicator's busy flag).
      // Drain the queue now that it's free, or a scan the phone requested
      // mid-apply would sit until the next scheduled run.
      scheduler.processQueue().catch(() => {})
    }
  })

  // Retry several Needs Attention jobs in one pass.
  ipcMain.handle('attention:applyMany', async (_, jobIds) => {
    if (!Array.isArray(jobIds) || jobIds.length === 0) {
      return { success: false, reason: 'No jobs selected' }
    }
    try {
      const saved = configService.load()
      const cfg = { ...saved, askQuestion: makeAskQuestion(getWindow()), confirmSubmit: saved.confirmBeforeSubmit ? makeConfirmSubmit(getWindow()) : undefined }
      return await applicator.applyAttentionJobs(jobIds, cfg, attentionLog)
    } catch (err) {
      return { success: false, reason: err.message }
    } finally {
      scheduler.processQueue().catch(() => {})
    }
  })

  // Stop a bulk approve or bulk retry after the submission in hand.
  ipcMain.handle('apply:cancelBulk', () => applicator.cancelBulk())

  // ─── Fill a career-site form, submit by hand ─────────────────────
  // Resolves when the browser window closes. `source` is 'attention' or 'held'.
  // Résumé routing applies exactly as it does to an automatic apply.
  const formAssist = require('../services/formAssist')
  const resolveCfg = (cfg, job) => applicator.resolveActiveResume(cfg, job, attentionLog)
  ipcMain.handle('formAssist:open', async (_, source, id) => {
    try {
      return await formAssist.open({ source, id }, { log: attentionLog, resolveCfg })
    } catch (err) {
      return { success: false, reason: err.message }
    }
  })
  // The person says they sent it, when the confirmation page was not seen.
  ipcMain.handle('formAssist:markSubmitted', (_, payload) => {
    try {
      return formAssist.markSubmitted(payload || {}, { resolveCfg })
    } catch (err) {
      return { success: false, reason: err.message }
    }
  })

  function attentionLog(msg) {
    logger.append(`[attention-apply] ${msg}`)
    if (getWindow() && !getWindow().isDestroyed()) {
      getWindow().webContents.send('attention:log', msg)
    }
  }

  // ─── IPC: Review queue (review-before-submit) ────────────────────
  ipcMain.handle('review:list', () => database.getHeldApplications())

  ipcMain.handle('review:approve', async (_, id) => {
    try {
      // User-initiated submissions receive the final confirmation callback. A
      // scheduled scan gets none and cannot block on a modal nobody may answer.
      const saved = configService.load()
      const cfg = {
        ...saved,
        askQuestion: makeAskQuestion(getWindow()),
        confirmSubmit: saved.confirmBeforeSubmit ? makeConfirmSubmit(getWindow()) : undefined,
      }
      return await applicator.approveHeldApplication(id, cfg, reviewLog)
    } catch (err) {
      return { success: false, reason: err.message }
    } finally {
      scheduler.processQueue().catch(() => {})
    }
  })

  ipcMain.handle('review:approveMany', async (_, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return { success: false, reason: 'No applications selected' }
    try {
      // User-initiated submissions receive the final confirmation callback. A
      // scheduled scan gets none and cannot block on a modal nobody may answer.
      const saved = configService.load()
      const cfg = {
        ...saved,
        askQuestion: makeAskQuestion(getWindow()),
        confirmSubmit: saved.confirmBeforeSubmit ? makeConfirmSubmit(getWindow()) : undefined,
      }
      return await applicator.approveHeldApplications(ids, cfg, reviewLog)
    } catch (err) {
      return { success: false, reason: err.message }
    } finally {
      scheduler.processQueue().catch(() => {})
    }
  })

  // Edit a held draft's documents before approving it. Refused while a
  // submission is running, which may be reading this very row.
  ipcMain.handle('review:editDraft', (_, id, edits) => {
    if (applicator.isBusy()) return { success: false, reason: 'A submission is running — wait for it to finish, then save your edit.' }
    try { return applicator.editHeldDraft(Number(id), edits || {}) } catch (err) { return { success: false, reason: err.message } }
  })

  ipcMain.handle('review:reject', (_, id) => {
    try { return database.rejectHeldApplication(id) } catch (err) { return { success: false, error: err.message } }
  })

  ipcMain.handle('review:followUps', () => database.getFollowUpDrafts())
  // Drafts whose email is on its way. The status check below cannot stop a
  // second click — the draft stays 'held' until the SMTP send returns — so a
  // double-click, or the phone and the desktop at once, emailed the recruiter
  // twice.
  const sendingFollowUps = new Set()
  ipcMain.handle('review:approveFollowUp', async (_, id) => {
    const key = Number(id)
    if (sendingFollowUps.has(key)) return { success: false, reason: 'That follow-up is already being sent.' }
    sendingFollowUps.add(key)
    try {
      const draft = database.getFollowUpDraft(id)
      if (!draft || draft.status !== 'held') return { success: false, reason: 'Follow-up draft not found' }
      const cfg = configService.load()
      await emailService.sendFollowUpEmail({
        job_title: draft.job_title, company: draft.company,
        recruiter_email: draft.recipient,
      }, draft.body, cfg)
      // resolveFollowUpDraft marks the application's follow-up decided; the email
      // has already gone, so it must run even if something below were to fail.
      return database.resolveFollowUpDraft(id, 'sent')
    } catch (err) {
      return { success: false, reason: err.message }
    } finally {
      sendingFollowUps.delete(key)
    }
  })
  // Declining settles the draft too, precisely so a rejection cannot leave the
  // application due for redrafting on the next pass. It is MORE final than
  // sending, now that there is more than one round: sending advances to the next
  // stage, declining ends the sequence — the user looked at chasing this employer
  // and said no, and offering the same thing again in a fortnight is that same
  // answer being ignored.
  ipcMain.handle('review:rejectFollowUp', (_, id) => {
    try {
      const draft = database.getFollowUpDraft(id)
      if (!draft || draft.status !== 'held') return { success: false, reason: 'Follow-up draft not found' }
      return database.resolveFollowUpDraft(id, 'rejected')
    } catch (err) { return { success: false, reason: err.message } }
  })

  function reviewLog(msg) {
    logger.append(`[review] ${msg}`)
    if (getWindow() && !getWindow().isDestroyed()) getWindow().webContents.send('review:log', msg)
  }

  return { reviewLog }
}

module.exports = registerApplicationHandlers
