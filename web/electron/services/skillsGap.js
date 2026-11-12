// Skills employers keep asking for that the résumé never mentions.
//
// The keyword-gap analysis on a single job answers "what is this ad looking for
// that I have not said?" — useful for one application, and forgotten after it.
// The question worth changing the master résumé over is the aggregate one: over
// the last few months of ads Hiro has read, which skills come up again and
// again, and which of those does the résumé not name at all?
//
// Done locally and deterministically, against a vocabulary of skills (plus any
// the user adds), rather than by a model: it reads every recent ad on each run,
// costs nothing, gives the same answer twice, and a count of "12 of 40 ads" can
// be checked by opening those ads. A model asked to tally forty adverts would be
// none of those things.
//
// A skill the résumé does not name is NOT a claim the user lacks it — plenty of
// people have used Docker without writing it down. The report says "not in your
// résumé", and the decision to add it is the user's. Nothing here writes to a
// résumé.

const configService = require('./config')
const database = require('./database')

// canonical name → the spellings that count for it. Matched as whole words,
// case-insensitively. Short or ambiguous names ("Go", "R", "C") are left out on
// purpose: "go" and "r" match ordinary English, and a report that says half the
// market wants Go because every ad says "go above and beyond" is worse than none.
// For the same reason React, REST, Excel, Swift and Node are only counted in
// spellings English does not use ("react to change", "the rest of the team",
// "you will excel", "a swift turnaround"), and a word straight after a dot is
// not a match ("js" in "Node.js" is not JavaScript).
const VOCABULARY = {
  // Languages
  'JavaScript': ['javascript', 'js', 'es6'], 'TypeScript': ['typescript'], 'Python': ['python'], 'Java': ['java'],
  'C#': ['c#', 'csharp'], 'C++': ['c\\+\\+', 'cpp'], 'Golang': ['golang'], 'Rust': ['rust'], 'Ruby': ['ruby'], 'PHP': ['php'],
  'Kotlin': ['kotlin'], 'Swift': ['swiftui', 'swift developer', 'swift/objective-c', 'swift and objective-c'], 'Scala': ['scala'], 'SQL': ['sql', 't-sql', 'pl/sql'], 'Bash': ['bash', 'shell scripting'],
  'PowerShell': ['powershell'], 'MATLAB': ['matlab'], 'SAS': ['sas'], 'VBA': ['vba'],
  // Front end / back end frameworks
  'React': ['react(?!\\s+(?:to|quickly|swiftly|fast|calmly))', 'react\\.js', 'reactjs'], 'Angular': ['angular'], 'Vue': ['vue', 'vue\\.js', 'vuejs'], 'Next.js': ['next\\.js', 'nextjs'],
  'Node.js': ['node\\.js', 'nodejs'], 'Express': ['express\\.js', 'expressjs'], 'Django': ['django'], 'Flask': ['flask'],
  'FastAPI': ['fastapi'], 'Spring': ['spring boot', 'spring framework'], '.NET': ['\\.net', 'dotnet', 'asp\\.net'],
  'Ruby on Rails': ['rails', 'ruby on rails'], 'Laravel': ['laravel'], 'GraphQL': ['graphql'], 'REST APIs': ['restful', 'rest api', 'rest apis', 'rest services'],
  'HTML': ['html', 'html5'], 'CSS': ['css', 'css3', 'sass', 'scss'], 'Tailwind': ['tailwind'], 'Redux': ['redux'],
  'React Native': ['react native'], 'Flutter': ['flutter'], 'iOS': ['ios'], 'Android': ['android'],
  // Cloud, infrastructure, delivery
  'AWS': ['aws', 'amazon web services'], 'Azure': ['azure'], 'Google Cloud': ['gcp', 'google cloud'], 'Docker': ['docker', 'containers?'],
  'Kubernetes': ['kubernetes', 'k8s', 'eks', 'aks', 'gke'], 'Terraform': ['terraform'], 'CloudFormation': ['cloudformation'],
  'Ansible': ['ansible'], 'CI/CD': ['ci/cd', 'cicd', 'continuous integration', 'continuous delivery', 'continuous deployment'],
  'GitHub Actions': ['github actions'], 'Jenkins': ['jenkins'], 'GitLab': ['gitlab'], 'Git': ['git'], 'Linux': ['linux', 'unix'],
  'Serverless': ['serverless', 'lambda'], 'Microservices': ['microservices?'], 'Observability': ['observability', 'datadog', 'prometheus', 'grafana', 'new relic', 'splunk'],
  'Networking': ['tcp/ip', 'networking', 'dns', 'vpn'], 'DevOps': ['devops'], 'SRE': ['sre', 'site reliability'],
  // Data
  'PostgreSQL': ['postgres', 'postgresql'], 'MySQL': ['mysql'], 'SQL Server': ['sql server', 'mssql'], 'Oracle': ['oracle'],
  'MongoDB': ['mongodb', 'mongo'], 'Redis': ['redis'], 'Elasticsearch': ['elasticsearch', 'opensearch'], 'DynamoDB': ['dynamodb'],
  'Snowflake': ['snowflake'], 'Databricks': ['databricks'], 'BigQuery': ['bigquery'], 'Redshift': ['redshift'],
  'Spark': ['spark', 'pyspark'], 'Kafka': ['kafka'], 'Airflow': ['airflow'], 'dbt': ['dbt'], 'ETL': ['etl', 'elt', 'data pipelines?'],
  'Data modelling': ['data model(?:l)?ing', 'dimensional model(?:l)?ing'], 'Data warehousing': ['data warehous(?:e|ing)'],
  'Power BI': ['power bi', 'powerbi'], 'Tableau': ['tableau'], 'Looker': ['looker'], 'Excel': ['microsoft excel', 'ms excel', 'advanced excel', 'excel (?:skills|modell?ing|formulas|macros)', 'spreadsheets?'],
  'pandas': ['pandas'], 'NumPy': ['numpy'], 'Statistics': ['statistics', 'statistical'],
  'Machine learning': ['machine learning', 'ml'], 'Deep learning': ['deep learning'], 'NLP': ['nlp', 'natural language processing'],
  'LLMs': ['llms?', 'large language models?', 'generative ai', 'genai'], 'PyTorch': ['pytorch'], 'TensorFlow': ['tensorflow'],
  'scikit-learn': ['scikit-learn', 'sklearn'], 'MLOps': ['mlops'], 'A/B testing': ['a/b testing', 'experimentation'],
  // Quality and security
  'Automated testing': ['automated testing', 'test automation', 'unit testing', 'integration testing', 'tdd'],
  'Cypress': ['cypress'], 'Playwright': ['playwright'], 'Selenium': ['selenium'], 'Jest': ['jest'],
  'Security': ['cyber ?security', 'information security', 'appsec', 'owasp'], 'IAM': ['iam', 'identity and access management', 'okta', 'active directory', 'entra'],
  'ISO 27001': ['iso ?27001'], 'SOC 2': ['soc ?2'], 'Penetration testing': ['penetration testing', 'pen testing', 'pentesting'],
  // Ways of working
  'Agile': ['agile'], 'Scrum': ['scrum'], 'Kanban': ['kanban'], 'Jira': ['jira'], 'Confluence': ['confluence'],
  'System design': ['system design', 'distributed systems', 'software architecture', 'solution architecture'],
  'Code review': ['code reviews?'], 'Mentoring': ['mentor(?:ing)?', 'coaching'], 'Stakeholder management': ['stakeholder management', 'stakeholder engagement'],
  'Product management': ['product management', 'product roadmap', 'roadmapping'], 'Project management': ['project management', 'pmp', 'prince2'],
  'Requirements analysis': ['requirements gathering', 'business analysis', 'requirements analysis', 'user stories'],
  'Change management': ['change management'], 'Vendor management': ['vendor management', 'procurement'],
  'Budget management': ['budget management', 'budgeting', 'p&l'], 'Customer service': ['customer service', 'customer experience'],
  'Sales': ['sales', 'business development'], 'CRM': ['crm', 'salesforce', 'hubspot', 'dynamics 365'], 'SAP': ['sap'],
  'Xero': ['xero'], 'MYOB': ['myob'], 'Financial modelling': ['financial model(?:l)?ing'], 'Forecasting': ['forecasting'],
  // Design and content
  'Figma': ['figma'], 'UX research': ['ux research', 'user research', 'usability testing'], 'UI design': ['ui design', 'interaction design'],
  'Accessibility': ['accessibility', 'wcag', 'a11y'], 'Adobe Creative Suite': ['photoshop', 'illustrator', 'indesign', 'adobe creative'],
  'SEO': ['seo'], 'Content strategy': ['content strategy', 'copywriting'], 'Google Analytics': ['google analytics', 'ga4'],
  'Digital marketing': ['digital marketing', 'sem', 'paid social', 'performance marketing'],
}

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// One regex per skill: any of its spellings as a whole word. The spellings
// above are regex fragments (so "containers?" covers both); a user's own term is
// escaped and matched literally.
function compile(vocabulary) {
  return Object.entries(vocabulary).map(([skill, spellings]) => ({
    skill,
    re: new RegExp(`(?:^|[^\\p{L}\\p{N}+#.])(?:${spellings.join('|')})(?=$|[^\\p{L}\\p{N}+#])`, 'iu'),
  }))
}
const COMPILED = compile(VOCABULARY)

function customTerms(list) {
  const parts = Array.isArray(list) ? list : String(list || '').split(/[,\n]/)
  const out = {}
  for (const raw of parts) {
    const t = String(raw || '').trim()
    if (t && t.length <= 60) out[t] = [escapeRegExp(t.toLowerCase())]
  }
  return out
}

// Every résumé the user has, so a skill counted as missing really is missing
// from all of them — and the report can say which résumé does name it.
function resumesOf(cfg) {
  const list = (Array.isArray(cfg.resumes) ? cfg.resumes : [])
    .filter(r => r && typeof r.text === 'string' && r.text.trim())
    .map(r => ({ id: r.id, name: r.name || 'Résumé', text: r.text }))
  if (cfg.masterResume && !list.some(r => r.text === cfg.masterResume)) list.unshift({ id: 'master', name: 'Master résumé', text: cfg.masterResume })
  return list
}

// The report. `jobs` and `cfg` are injectable for tests.
//   minShare — a skill must appear in at least this share of ads to be listed
//   minJobs  — and in at least this many, so three ads cannot make a "trend"
function analyse({ cfg = configService.load(), jobs, days = 90, minShare = 0.1, minJobs = 3, limit = 25 } = {}) {
  const ads = jobs || database.getRecentJobDescriptions(days)
  const resumes = resumesOf(cfg)
  const matchers = [...COMPILED, ...compile(customTerms(cfg.skillTerms))]
  const sample = ads.length

  const rows = []
  for (const { skill, re } of matchers) {
    let count = 0
    let strong = 0
    const examples = []
    for (const ad of ads) {
      if (!re.test(`${ad.job_title || ''}\n${ad.job_description || ''}`)) continue
      count++
      if (Number(ad.match_score) >= 70) strong++
      if (examples.length < 3) examples.push({ company: ad.company || '', job_title: ad.job_title || '' })
    }
    if (!count) continue
    const inResumes = resumes.filter(r => re.test(r.text)).map(r => r.name)
    rows.push({ skill, jobs: count, share: sample ? Math.round((count / sample) * 100) / 100 : 0, strongMatches: strong, inResume: inResumes.length > 0, inResumes, examples })
  }
  rows.sort((a, b) => b.jobs - a.jobs || a.skill.localeCompare(b.skill))

  const trending = rows.filter(r => r.jobs >= minJobs && r.share >= minShare)
  return {
    sample,
    days,
    hasResume: resumes.length > 0,
    missing: trending.filter(r => !r.inResume).slice(0, limit),
    covered: trending.filter(r => r.inResume).slice(0, limit),
    // Too few ads to call anything a trend: said, rather than shown as an empty
    // report that reads as "your résumé covers everything".
    enoughData: sample >= Math.max(minJobs * 2, 8),
  }
}

module.exports = { analyse, VOCABULARY, customTerms, resumesOf }
