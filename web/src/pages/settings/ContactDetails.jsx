// Name, email and phone for company career-site forms.
//
// The auto-apply boards already know these from the account Hiro signs in
// with; a company's own careers page does not. Blank fields are read off the
// résumé when a form is filled, so this is only needed where the résumé says
// something different from what the form should receive.

const FIELDS = [
  { id: 'fullName', label: 'Full name', placeholder: 'From the first line of your résumé' },
  { id: 'email', label: 'Email', placeholder: 'From your résumé', type: 'email' },
  { id: 'phone', label: 'Phone', placeholder: 'From your résumé', type: 'tel' },
  { id: 'location', label: 'Location', placeholder: 'Your job search location' },
]

export function ContactDetails({ form, set }) {
  const details = (form.contactDetails && typeof form.contactDetails === 'object') ? form.contactDetails : {}
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 6, fontSize: 15 }}>Contact Details for Application Forms</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.55 }}>
        Used by <strong>Fill Application</strong> on company career sites. Leave a field blank to use
        what your résumé says. LinkedIn, GitHub and portfolio links come from Personal Links in Settings.
      </p>
      {FIELDS.map(f => (
        <div className="form-group" key={f.id}>
          <label htmlFor={`contact-${f.id}`}>{f.label}</label>
          <input id={`contact-${f.id}`} type={f.type || 'text'}
            value={details[f.id] || ''}
            placeholder={f.placeholder}
            onChange={e => set('contactDetails', { ...details, [f.id]: e.target.value })} />
        </div>
      ))}
    </div>
  )
}
