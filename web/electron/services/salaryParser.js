// Turn a job board's free-text salary string into an annual numeric range.
//
// `salary` was stored exactly as scraped ("$120,000 – $140,000 p.a. + super"),
// which reads fine but can't be filtered, sorted, or averaged. This normalises
// it to { min, max } in annual dollars so the dashboard can do all three.
//
// Deliberately deterministic and conservative — no AI call, and it returns null
// rather than guessing when the string doesn't clearly state a number. Callers
// treat null as "unknown", never as zero.

// Australian full-time convention: 38-hour week, 52 weeks.
const HOURS_PER_YEAR = 38 * 52   // 1976
const DAYS_PER_YEAR = 5 * 52     // 260
const WEEKS_PER_YEAR = 52
const MONTHS_PER_YEAR = 12

// A parsed figure below this is treated as a rate (hourly/daily) that we failed
// to label, not an annual salary — nobody advertises a $400/year job.
const MIN_PLAUSIBLE_ANNUAL = 20000
// Above this the number is almost certainly not a salary (a phone number, an
// ABN, a "$5,000,000 in funding" boast that leaked into the field).
const MAX_PLAUSIBLE_ANNUAL = 2000000

// Which period the figure is quoted in. Checked in order, longest first, so
// "per annum" doesn't match on a bare "an".
const PERIODS = [
  { re: /\b(?:per\s+hour|hourly|an\s+hour|\/\s*hr|\/\s*hour|p\.?h\.?)\b/i, factor: HOURS_PER_YEAR },
  { re: /\b(?:per\s+day|daily|a\s+day|\/\s*day|day\s+rate)\b/i, factor: DAYS_PER_YEAR },
  { re: /\b(?:per\s+week|weekly|a\s+week|\/\s*wk|\/\s*week)\b/i, factor: WEEKS_PER_YEAR },
  { re: /\b(?:per\s+month|monthly|a\s+month|\/\s*month|p\.?m\.?)\b/i, factor: MONTHS_PER_YEAR },
  { re: /\b(?:per\s+annum|per\s+year|annually|annual|a\s+year|\/\s*yr|\/\s*year|p\.?a\.?)\b/i, factor: 1 },
]

function detectFactor(text) {
  for (const { re, factor } of PERIODS) {
    if (re.test(text)) return factor
  }
  return null
}

// "120,000" → 120000, "120k" → 120000, "1.2m" → 1200000
function toNumber(raw, suffix) {
  const n = Number(String(raw).replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const s = (suffix || '').toLowerCase()
  if (s === 'k') return Math.round(n * 1000)
  if (s === 'm') return Math.round(n * 1000000)
  return Math.round(n)
}

// Every number in the string that looks like money, in order of appearance.
// Requires either a currency symbol or a k/m suffix so that "38 hours" and
// "2025" don't register as pay.
function extractFigures(text) {
  const out = []
  const re = /(?:\$|AUD?\s*\$?|NZD?\s*\$?)\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?\b|\b(\d[\d,]*(?:\.\d+)?)\s*([km])\b/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const value = toNumber(m[1] ?? m[3], m[2] ?? m[4])
    if (value != null && value > 0) out.push(value)
  }
  return out
}

// An unlabelled figure at or above this is read as a day rate rather than an
// hourly one. Hourly rates in job ads top out around $200; day rates start
// around $400. Splitting between them means "$65" annualises as hourly and
// "$750" as daily, which is what each actually is.
const MAX_PLAUSIBLE_HOURLY = 250

// Bring a figure into annual terms. When the string states a period, trust it.
// When it doesn't, infer from magnitude: a bare "$65" is an hourly rate, "$750"
// is a day rate, and "$95,000" is a salary — guessing wrong by a factor of
// 2000 is worse than the small risk of the heuristic.
function annualise(value, statedFactor) {
  if (statedFactor != null) return Math.round(value * statedFactor)
  if (value < MAX_PLAUSIBLE_HOURLY) return Math.round(value * HOURS_PER_YEAR)
  if (value < MIN_PLAUSIBLE_ANNUAL) return Math.round(value * DAYS_PER_YEAR)
  return value
}

function plausible(value) {
  return value >= MIN_PLAUSIBLE_ANNUAL && value <= MAX_PLAUSIBLE_ANNUAL
}

// Returns { min, max } in annual dollars, or null when nothing usable was
// found. A single figure yields min === max, except for an explicit "up to" /
// "from" bound, where only the stated side is set.
function parseSalary(text) {
  if (!text || typeof text !== 'string') return null
  const s = text.trim()
  if (!s) return null

  const factor = detectFactor(s)
  const figures = extractFigures(s).map(v => annualise(v, factor)).filter(plausible)
  if (figures.length === 0) return null

  const lo = Math.min(...figures)
  const hi = Math.max(...figures)

  // "Up to $130,000" states a ceiling with no floor; "from $90,000" the reverse.
  // A trailing "+" is tested separately: `\b` is a word boundary and doesn't
  // apply to "+", so including it in the alternation below never matched.
  if (figures.length === 1) {
    if (/\b(?:up\s+to|max(?:imum)?\s+of|below|under)\b/i.test(s)) {
      return { min: null, max: hi }
    }
    // A bare trailing "+" means "or more". "+ super" / "+ bonus" does not — in
    // Australian ads that's the base figure plus entitlements on top, which is
    // still a single stated number, not an open-ended range.
    const bareTrailingPlus = /\d[\d,.k]*\s*\+\s*$/i.test(s.trim())
    if (/\b(?:from|starting\s+(?:at|from)|min(?:imum)?\s+of|upwards\s+of)\b/i.test(s) || bareTrailingPlus) {
      return { min: lo, max: null }
    }
  }

  return { min: lo, max: hi }
}

// Convenience for the scrapers: the shape the database columns expect.
function parseSalaryColumns(text) {
  const parsed = parseSalary(text)
  return { salary_min: parsed?.min ?? null, salary_max: parsed?.max ?? null }
}

// Human-readable annual figure for the UI ("$120k – $140k", "up to $130k").
function formatSalaryRange(min, max) {
  const k = (n) => (n % 1000 === 0 ? `$${Math.round(n / 1000)}k` : `$${n.toLocaleString('en-AU')}`)
  if (min == null && max == null) return ''
  if (min == null) return `up to ${k(max)}`
  if (max == null) return `${k(min)}+`
  if (min === max) return k(min)
  return `${k(min)} – ${k(max)}`
}

module.exports = {
  parseSalary,
  parseSalaryColumns,
  formatSalaryRange,
  // exported for tests
  HOURS_PER_YEAR,
  DAYS_PER_YEAR,
}
