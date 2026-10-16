// Salary strings come from three job boards with no agreed format, and the
// parsed numbers drive filtering, sorting, and the Analytics averages — so a
// misparse doesn't just look wrong, it hides jobs behind a filter. These cases
// are the real shapes seen on Seek/Indeed/LinkedIn AU listings.

const { createChecker, service } = require('./helpers')
const { parseSalary, parseSalaryColumns, formatSalaryRange, HOURS_PER_YEAR, DAYS_PER_YEAR } = service('salaryParser')

const { check, done } = createChecker()

// ─── Annual ranges ───────────────────────────────────────────────
check('plain annual range', parseSalary('$120,000 - $140,000'), { min: 120000, max: 140000 })
check('en-dash range', parseSalary('$120,000 – $140,000 per annum'), { min: 120000, max: 140000 })
check('k-suffix range', parseSalary('$120k - $140k'), { min: 120000, max: 140000 })
check('range with super noise', parseSalary('$130,000 – $150,000 + super + bonus'), { min: 130000, max: 150000 })
check('single annual figure', parseSalary('$125,000'), { min: 125000, max: 125000 })
check('AUD prefix', parseSalary('AUD $110,000 per year'), { min: 110000, max: 110000 })

// ─── Rates normalised to annual ──────────────────────────────────
check('hourly rate range', parseSalary('$60 - $70 per hour'), { min: 60 * HOURS_PER_YEAR, max: 70 * HOURS_PER_YEAR })
check('hourly with slash', parseSalary('$55/hr'), { min: 55 * HOURS_PER_YEAR, max: 55 * HOURS_PER_YEAR })
check('day rate', parseSalary('$800 per day'), { min: 800 * DAYS_PER_YEAR, max: 800 * DAYS_PER_YEAR })
check('day rate phrasing', parseSalary('$900 day rate'), { min: 900 * DAYS_PER_YEAR, max: 900 * DAYS_PER_YEAR })

// Unlabelled figures are inferred by magnitude — a bare "$65" is a rate, not a
// $65/year job. Getting this wrong is a 2000x error, which is why it's guessed
// rather than dropped.
check('bare small figure read as hourly', parseSalary('$65'), { min: 65 * HOURS_PER_YEAR, max: 65 * HOURS_PER_YEAR })
check('bare mid figure read as day rate', parseSalary('$750'), { min: 750 * DAYS_PER_YEAR, max: 750 * DAYS_PER_YEAR })

// ─── One-sided bounds ────────────────────────────────────────────
check('up to caps the max only', parseSalary('Up to $130,000'), { min: null, max: 130000 })
check('from sets the min only', parseSalary('From $95,000'), { min: 95000, max: null })
check('bare trailing plus sets the min only', parseSalary('$140,000 +'), { min: 140000, max: null })
// "+ super" is the base figure plus entitlements, not an open-ended range —
// reading it as open-ended would make the job match any max-salary filter.
check('plus super is a stated figure, not an open range', parseSalary('$140,000 + super'), { min: 140000, max: 140000 })
check('plus bonus is a stated figure', parseSalary('$95,000 + bonus'), { min: 95000, max: 95000 })

// ─── Nothing usable ──────────────────────────────────────────────
check('empty string', parseSalary(''), null)
check('null input', parseSalary(null), null)
check('non-string input', parseSalary(42), null)
check('descriptive text only', parseSalary('Competitive salary'), null)
check('attractive package', parseSalary('Attractive remuneration package'), null)
// A bare number with no currency marker and no k/m suffix must not register —
// otherwise "38 hours per week" and "2025" become salaries.
check('hours per week is not a salary', parseSalary('38 hours per week'), null)
check('a bare year is not a salary', parseSalary('Posted 2025'), null)
check('implausibly large figure rejected', parseSalary('$5,000,000,000'), null)

// ─── Column shape used by the DB ─────────────────────────────────
check('columns for a range', parseSalaryColumns('$100k - $120k'), { salary_min: 100000, salary_max: 120000 })
check('columns when unparseable', parseSalaryColumns('Competitive'), { salary_min: null, salary_max: null })
check('columns for a one-sided bound', parseSalaryColumns('up to $90,000'), { salary_min: null, salary_max: 90000 })

// ─── Display ─────────────────────────────────────────────────────
check('formats a round range', formatSalaryRange(120000, 140000), '$120k – $140k')
check('formats a single figure', formatSalaryRange(120000, 120000), '$120k')
check('formats an open top', formatSalaryRange(140000, null), '$140k+')
check('formats an open bottom', formatSalaryRange(null, 130000), 'up to $130k')
check('formats nothing when unknown', formatSalaryRange(null, null), '')

// The range is ordered regardless of the order the figures appeared in.
check('reversed figures still yield min<max', parseSalary('$140,000 down from $120,000'), { min: 120000, max: 140000 })

// ── The period belongs to the number it follows ─────────────────────
// It used to be searched for anywhere in the string, so a clause about
// something else entirely set the pay period for the salary.
check('"a week" later in the text does not make a salary weekly',
  parseSalary('$120,000 + super, 2 days a week in office'), { min: 120000, max: 120000 })
check('"pm" in working hours does not make a salary monthly',
  parseSalary('$95k, 9 am – 5 pm'), { min: 95000, max: 95000 })
check('p.w. directly after the figure is weekly', parseSalary('$1,800 p.w.'), { min: 93600, max: 93600 })
check('/wk directly after the figure is weekly', parseSalary('$1,800/wk'), { min: 93600, max: 93600 })
check('per month directly after the figure is monthly', parseSalary('$8,000 per month'), { min: 96000, max: 96000 })
check('p.m. directly after the figure is monthly', parseSalary('$8,000 p.m.'), { min: 96000, max: 96000 })
check('a rate named before the figure still counts', parseSalary('Hourly rate of $65'), { min: 65 * HOURS_PER_YEAR, max: 65 * HOURS_PER_YEAR })
check('an annual-looking amount is never multiplied', parseSalary('$120,000 a week'), { min: 120000, max: 120000 })

check('fractional hourly rate retains cents', parseSalary('$60.50/hour'), { min: 119548, max: 119548 })
check('bonus is not the bottom of a range', parseSalary('$100,000 + $20,000 bonus'), { min: 100000, max: 100000 })
check('pounds are parsed', parseSalary('\u00a350,000 - \u00a360,000 a year'), { min: 50000, max: 60000 })
check('euros are parsed', parseSalary('\u20ac70,000 per year'), { min: 70000, max: 70000 })
done()
