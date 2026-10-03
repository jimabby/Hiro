// Export applications to CSV and say how it went.
//
// Both buttons used to call the IPC and drop the result, so a successful
// export showed nothing and a failed one — most often a file still open in
// Excel — rejected into the void.
export async function exportCsv(filters, showToast) {
  try {
    const res = await window.api.exportCSV(filters || {})
    if (!res || res.canceled) return
    if (res.success) {
      const n = Number(res.count) || 0
      showToast?.(`Exported ${n} application${n === 1 ? '' : 's'} to CSV`, 'success')
    } else {
      showToast?.(res.error || 'Export failed', 'error')
    }
  } catch (err) {
    showToast?.(`Export failed: ${err.message}`, 'error')
  }
}
