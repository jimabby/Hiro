import { useEffect, useState } from 'react'

const blankCampaign = { name: '', keywords: '', location: '', salaryMin: 0, scheduleTime: '09:00', enabled: true, reviewBeforeSubmit: true }
const blankJob = { url: '', title: '', company: '', description: '' }
const blankContact = { name: '', email: '', company: '', role: '', relationship: 'recruiter', notes: '', next_action_at: '' }
const dateAfter = days => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function Workbench({ active, showToast }) {
  const [campaigns, setCampaigns] = useState([])
  const [contacts, setContacts] = useState([])
  const [dueContacts, setDueContacts] = useState([])
  const [insights, setInsights] = useState([])
  const [analytics, setAnalytics] = useState([])
  const [resumes, setResumes] = useState([])
  const [campaign, setCampaign] = useState(blankCampaign)
  const [job, setJob] = useState(blankJob)
  const [contact, setContact] = useState(blankContact)

  const load = async () => {
    const [c, p, due, tips, stats, cfg] = await Promise.all([
      window.api.getCampaigns(), window.api.getContacts(), window.api.getDueContacts(),
      window.api.getOptimisationInsights(), window.api.getCampaignAnalytics(), window.api.getConfig(),
    ])
    setCampaigns(c || []); setContacts(p || []); setDueContacts(due || [])
    setInsights(tips || []); setAnalytics(stats || []); setResumes(cfg?.resumes || [])
  }
  useEffect(() => { if (active) load().catch(err => showToast?.(err.message, 'error')) }, [active, showToast])
  if (!active) return null

  const field = (state, setState, key, props = {}) => (
    <input className="input" value={state[key] ?? ''} onChange={e => setState({ ...state, [key]: e.target.value })} {...props} />
  )
  const reloadAction = async (work, success) => {
    const result = await work()
    if (result?.success === false) return showToast?.(result.reason || result.error, 'error')
    await load(); if (success) showToast?.(success, 'success')
  }

  return <div className="page">
    <div className="page-header"><div><h1>Workbench</h1><p>Campaigns, imported jobs, relationships, and evidence-backed improvements.</p></div></div>

    {dueContacts.length > 0 && <div className="card" style={{ marginBottom: 18, borderColor: 'var(--accent)' }}>
      <h2>Contact reminders due</h2>
      {dueContacts.map(person => <div className="list-row" key={person.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}><strong>{person.name || person.email}</strong><div className="text-muted">Due {person.next_action_at} · {[person.company, person.role].filter(Boolean).join(' · ')}</div></div>
        <button className="btn btn-ghost" onClick={() => reloadAction(() => window.api.snoozeContactReminder(person.id, dateAfter(7)), 'Reminder moved one week')}>Snooze 1 week</button>
        <button className="btn btn-primary" onClick={() => reloadAction(() => window.api.completeContactReminder(person.id), 'Contact reminder completed')}>Done</button>
      </div>)}
    </div>}

    <div className="stats-grid" style={{ marginBottom: 18 }}>{insights.map((tip, i) => <div className="card" key={i}><div className="stat-label">{tip.kind}</div><h3>{tip.title}</h3><p className="text-muted">{tip.detail}</p></div>)}</div>

    {analytics.length > 0 && <div className="card" style={{ marginBottom: 18 }}><h2>Campaign performance</h2>
      <div style={{ overflowX: 'auto' }}><table><thead><tr><th>Campaign</th><th>Runs</th><th>Found</th><th>Sent</th><th>Held</th><th>Avg score</th><th>Conversion</th><th>Failures</th></tr></thead><tbody>
        {analytics.map(row => <tr key={row.campaign_id}><td>{row.campaign_name || row.campaign_id}</td><td>{row.runs}</td><td>{row.found}</td><td>{row.sent || 0}</td><td>{row.held}</td><td>{row.avg_score ?? '—'}</td><td>{row.conversion_rate == null ? '—' : `${row.conversion_rate}%`}</td><td>{Number(row.failed_runs) + Number(row.scoring_failures)}</td></tr>)}
      </tbody></table></div>
    </div>}

    <div className="card" style={{ marginBottom: 18 }}><h2>Search campaigns</h2><p className="text-muted">Each enabled campaign runs weekdays at its own time and records its outcomes here.</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 2fr 1fr 110px 110px', gap: 8 }}>
        {field(campaign, setCampaign, 'name', { placeholder: 'Campaign name' })}{field(campaign, setCampaign, 'keywords', { placeholder: 'Keywords' })}{field(campaign, setCampaign, 'location', { placeholder: 'Location' })}{field(campaign, setCampaign, 'salaryMin', { type: 'number', min: 0, placeholder: 'Min salary' })}{field(campaign, setCampaign, 'scheduleTime', { type: 'time' })}
      </div>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginTop: 8 }}>
        <select className="input" value={campaign.resumeId || ''} onChange={e => setCampaign({ ...campaign, resumeId: e.target.value })}><option value="">Default routed resume</option>{resumes.map(r => <option key={r.id} value={r.id}>{r.name || 'Unnamed resume'}</option>)}</select>
        <label><input type="checkbox" checked={campaign.enabled !== false} onChange={e => setCampaign({ ...campaign, enabled: e.target.checked })} /> Enabled</label>
        <label><input type="checkbox" checked={campaign.reviewBeforeSubmit !== false} onChange={e => setCampaign({ ...campaign, reviewBeforeSubmit: e.target.checked })} /> Review before submit</label>
      </div>
      <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={() => reloadAction(async () => { const r = await window.api.saveCampaign(campaign); setCampaign(blankCampaign); return r }, 'Campaign saved')}>Save campaign</button>
      <div style={{ marginTop: 12 }}>{campaigns.map(c => <div key={c.id} className="list-row" style={{ display: 'flex', gap: 10, alignItems: 'center' }}><strong style={{ flex: 1 }}>{c.name}</strong><span className="text-muted">{c.enabled ? 'Enabled' : 'Paused'} · {c.keywords} · {c.location || 'anywhere'} · {c.scheduleTime}</span><button className="btn btn-ghost" onClick={() => reloadAction(() => window.api.runCampaign(c.id), 'Campaign scan queued')}>Run</button><button className="btn btn-ghost" onClick={() => setCampaign(c)}>Edit</button><button className="btn btn-ghost" onClick={() => reloadAction(() => window.api.deleteCampaign(c.id))}>Delete</button></div>)}</div>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
      <div className="card"><h2>Import any job</h2><p className="text-muted">Add a listing here or use the browser extension in <code>extension/</code>.</p>
        {field(job, setJob, 'url', { placeholder: 'https://company.example/jobs/…' })}<div style={{ display: 'flex', gap: 8, marginTop: 8 }}>{field(job, setJob, 'title', { placeholder: 'Role' })}{field(job, setJob, 'company', { placeholder: 'Company' })}</div><textarea className="input" style={{ marginTop: 8, minHeight: 90 }} value={job.description} onChange={e => setJob({ ...job, description: e.target.value })} placeholder="Optional description" /><button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => reloadAction(async () => { const r = await window.api.importJob(job); if (r?.success !== false) setJob(blankJob); return r }, 'Job added to Needs Attention')}>Import</button>
      </div>
      <div className="card"><h2>Contacts & referrals</h2>
        <div style={{ display: 'flex', gap: 8 }}>{field(contact, setContact, 'name', { placeholder: 'Name' })}{field(contact, setContact, 'email', { type: 'email', placeholder: 'Email' })}</div><div style={{ display: 'flex', gap: 8, marginTop: 8 }}>{field(contact, setContact, 'company', { placeholder: 'Company' })}{field(contact, setContact, 'role', { placeholder: 'Role / context' })}</div><div style={{ display: 'flex', gap: 8, marginTop: 8 }}><select className="input" value={contact.relationship} onChange={e => setContact({ ...contact, relationship: e.target.value })}><option value="recruiter">Recruiter</option><option value="referral">Referral</option><option value="hiring-manager">Hiring manager</option><option value="network">Network</option></select>{field(contact, setContact, 'next_action_at', { type: 'date', title: 'Next action date' })}</div><textarea className="input" style={{ marginTop: 8, minHeight: 70 }} value={contact.notes} onChange={e => setContact({ ...contact, notes: e.target.value })} placeholder="Conversation notes or referral plan" /><button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => reloadAction(async () => { const r = await window.api.saveContact(contact); if (r.success) setContact(blankContact); return r }, 'Contact saved')}>Save contact</button>
        <div style={{ marginTop: 12 }}>{contacts.map(p => <div className="list-row" key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ flex: 1 }}><strong>{p.name || p.email}</strong><div className="text-muted">{p.relationship} · {p.company} {p.role && `· ${p.role}`} {p.next_action_at && `· next ${p.next_action_at}`}</div></div><button className="btn btn-ghost" onClick={() => setContact(p)}>Edit</button><button className="btn btn-ghost" onClick={() => reloadAction(() => window.api.deleteContact(p.id))}>Delete</button></div>)}</div>
      </div>
    </div>
  </div>
}
