// Every skill Hiro can name, and how each one is spotted in text.
//
// Two users. The skills-gap report (services/skillsGap.js) counts how many
// recent ads ask for each skill in REPORT_GROUPS. The "Other skills you have"
// picker in Settings offers those and PICKER_GROUPS, so a user can tick skills
// they really have that no résumé lists (config.extraSkills), without typing.
// Pure data and matching, with no config or database, so that the fabrication
// guard can recognise a ticked skill in a line.

// canonical name → the spellings that count for it. Matched as whole words,
// case-insensitively. Short or ambiguous names ("Go", "R", "C") are left out on
// purpose: "go" and "r" match ordinary English, and a report that says half the
// market wants Go because every ad says "go above and beyond" is worse than none.
// For the same reason React, REST, Excel, Swift and Node are only counted in
// spellings English does not use ("react to change", "the rest of the team",
// "you will excel", "a swift turnaround"), and a word straight after a dot is
// not a match ("js" in "Node.js" is not JavaScript).
const REPORT_GROUPS = {
  'Programming languages': {
    'JavaScript': ['javascript', 'js', 'es6'], 'TypeScript': ['typescript'], 'Python': ['python'], 'Java': ['java'],
    'C#': ['c#', 'csharp'], 'C++': ['c\\+\\+', 'cpp'], 'Golang': ['golang'], 'Rust': ['rust'], 'Ruby': ['ruby'], 'PHP': ['php'],
    'Kotlin': ['kotlin'], 'Swift': ['swiftui', 'swift developer', 'swift/objective-c', 'swift and objective-c'], 'Scala': ['scala'], 'SQL': ['sql', 't-sql', 'pl/sql'], 'Bash': ['bash', 'shell scripting'],
    'PowerShell': ['powershell'], 'MATLAB': ['matlab'], 'SAS': ['sas'], 'VBA': ['vba'],
  },
  'Frameworks': {
    'React': ['react(?!\\s+(?:to|quickly|swiftly|fast|calmly))', 'react\\.js', 'reactjs'], 'Angular': ['angular'], 'Vue': ['vue', 'vue\\.js', 'vuejs'], 'Next.js': ['next\\.js', 'nextjs'],
    'Node.js': ['node\\.js', 'nodejs'], 'Express': ['express\\.js', 'expressjs'], 'Django': ['django'], 'Flask': ['flask'],
    'FastAPI': ['fastapi'], 'Spring': ['spring boot', 'spring framework'], '.NET': ['\\.net', 'dotnet', 'asp\\.net'],
    'Ruby on Rails': ['rails', 'ruby on rails'], 'Laravel': ['laravel'], 'GraphQL': ['graphql'], 'REST APIs': ['restful', 'rest api', 'rest apis', 'rest services'],
    'HTML': ['html', 'html5'], 'CSS': ['css', 'css3', 'sass', 'scss'], 'Tailwind': ['tailwind'], 'Redux': ['redux'],
    'React Native': ['react native'], 'Flutter': ['flutter'], 'iOS': ['ios'], 'Android': ['android'],
  },
  'Cloud and delivery': {
    'AWS': ['aws', 'amazon web services'], 'Azure': ['azure'], 'Google Cloud': ['gcp', 'google cloud'], 'Docker': ['docker', 'containers?'],
    'Kubernetes': ['kubernetes', 'k8s', 'eks', 'aks', 'gke'], 'Terraform': ['terraform'], 'CloudFormation': ['cloudformation'],
    'Ansible': ['ansible'], 'CI/CD': ['ci/cd', 'cicd', 'continuous integration', 'continuous delivery', 'continuous deployment'],
    'GitHub Actions': ['github actions'], 'Jenkins': ['jenkins'], 'GitLab': ['gitlab'], 'Git': ['git'], 'Linux': ['linux', 'unix'],
    'Serverless': ['serverless', 'lambda'], 'Microservices': ['microservices?'], 'Observability': ['observability', 'datadog', 'prometheus', 'grafana', 'new relic', 'splunk'],
    'Networking': ['tcp/ip', 'networking', 'dns', 'vpn'], 'DevOps': ['devops'], 'SRE': ['sre', 'site reliability'],
  },
  'Data and AI': {
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
  },
  'Testing and security': {
    'Automated testing': ['automated testing', 'test automation', 'unit testing', 'integration testing', 'tdd'],
    'Cypress': ['cypress'], 'Playwright': ['playwright'], 'Selenium': ['selenium'], 'Jest': ['jest'],
    'Security': ['cyber ?security', 'information security', 'appsec', 'owasp'], 'IAM': ['iam', 'identity and access management', 'okta', 'active directory', 'entra'],
    'ISO 27001': ['iso ?27001'], 'SOC 2': ['soc ?2'], 'Penetration testing': ['penetration testing', 'pen testing', 'pentesting'],
  },
  'Ways of working': {
    'Agile': ['agile'], 'Scrum': ['scrum'], 'Kanban': ['kanban'], 'Jira': ['jira'], 'Confluence': ['confluence'],
    'System design': ['system design', 'distributed systems', 'software architecture', 'solution architecture'],
    'Code review': ['code reviews?'], 'Mentoring': ['mentor(?:ing)?', 'coaching'], 'Stakeholder management': ['stakeholder management', 'stakeholder engagement'],
    'Product management': ['product management', 'product roadmap', 'roadmapping'], 'Project management': ['project management', 'pmp', 'prince2'],
    'Requirements analysis': ['requirements gathering', 'business analysis', 'requirements analysis', 'user stories'],
    'Change management': ['change management'], 'Vendor management': ['vendor management', 'procurement'],
    'Budget management': ['budget management', 'budgeting', 'p&l'], 'Customer service': ['customer service', 'customer experience'],
    'Sales': ['sales', 'business development'], 'CRM': ['crm', 'salesforce', 'hubspot', 'dynamics 365'], 'SAP': ['sap'],
    'Xero': ['xero'], 'MYOB': ['myob'], 'Financial modelling': ['financial model(?:l)?ing'], 'Forecasting': ['forecasting'],
  },
  'Design and marketing': {
    'Figma': ['figma'], 'UX research': ['ux research', 'user research', 'usability testing'], 'UI design': ['ui design', 'interaction design'],
    'Accessibility': ['accessibility', 'wcag', 'a11y'], 'Adobe Creative Suite': ['photoshop', 'illustrator', 'indesign', 'adobe creative'],
    'SEO': ['seo'], 'Content strategy': ['content strategy', 'copywriting'], 'Google Analytics': ['google analytics', 'ga4'],
    'Digital marketing': ['digital marketing', 'sem', 'paid social', 'performance marketing'],
  },
}

const VOCABULARY = Object.assign({}, ...Object.values(REPORT_GROUPS))

// Offered by the picker but not counted by the report: the specific tools the
// report folds into a broader heading (it counts Active Directory as IAM and
// Salesforce as CRM), and things ads require that are not skills in the
// report's sense, such as licences, checks and spoken languages. Apostrophes
// may be curly in a model's output, hence ['’].
const PICKER_GROUPS = {
  'IT support': {
    'Microsoft 365': ['microsoft 365', 'office 365', 'm365', 'o365'],
    'Active Directory': ['active directory'],
    'Entra ID': ['entra id', 'azure ad', 'azure active directory'],
    'Intune': ['intune'],
    'Windows Server': ['windows server'],
    'Exchange': ['exchange online', 'exchange server', 'microsoft exchange'],
    'SharePoint': ['sharepoint'],
    'ServiceNow': ['servicenow'],
    'ITIL': ['itil'],
    'Service desk': ['service desk', 'help ?desk'],
    'VMware': ['vmware', 'vsphere'],
    'Hyper-V': ['hyper-v'],
    'Citrix': ['citrix'],
    'macOS support': ['macos', 'mac os'],
    'Jamf': ['jamf'],
  },
  'More tools': {
    'ASP.NET Core': ['asp\\.net core'],
    'Entity Framework': ['entity framework', 'ef core'],
    'Azure DevOps': ['azure devops'],
    'NestJS': ['nestjs', 'nest\\.js'],
    'Svelte': ['svelte', 'sveltekit'],
    'jQuery': ['jquery'],
    'Webpack': ['webpack'],
    'Storybook': ['storybook'],
    'Postman': ['postman'],
    'Nginx': ['nginx'],
    'RabbitMQ': ['rabbitmq'],
    'gRPC': ['grpc'],
    'WebSockets': ['websockets?'],
    'Firebase': ['firebase'],
    'Supabase': ['supabase'],
    'Prisma': ['prisma'],
    'SQLite': ['sqlite'],
    'Cassandra': ['cassandra'],
    'Helm': ['helm'],
    'LangChain': ['langchain'],
    'Hugging Face': ['hugging ?face'],
    'WordPress': ['wordpress'],
    'Shopify': ['shopify'],
    'Salesforce': ['salesforce'],
    'HubSpot': ['hubspot'],
    'Dynamics 365': ['dynamics 365'],
    'Okta': ['okta'],
    'Datadog': ['datadog'],
    'Grafana': ['grafana'],
    'Splunk': ['splunk'],
  },
  'Licences and checks': {
    "Driver's licence": ["driver['’]?s licen[cs]e", "drivers['’]? licen[cs]e", 'driving licen[cs]e', 'driver licen[cs]e'],
    'Working with Children Check': ['working with children check', 'wwcc', 'blue card'],
    'Police check': ['police check', 'national police check', 'criminal (?:history|record) check'],
    'First aid certificate': ['first aid(?: certificate| certification| certified)?'],
    'White Card': ['white card'],
    'Forklift licence': ['forklift licen[cs]e'],
  },
  'Spoken languages': {
    'Mandarin': ['mandarin'], 'Cantonese': ['cantonese'], 'Vietnamese': ['vietnamese'], 'Korean': ['korean'],
    'Japanese': ['japanese'], 'Hindi': ['hindi'], 'Punjabi': ['punjabi'], 'Arabic': ['arabic'],
    'Spanish': ['spanish'], 'French': ['french'], 'German': ['german'], 'Italian': ['italian'],
    'Greek': ['greek'], 'Indonesian': ['indonesian', 'bahasa'], 'Tagalog': ['tagalog', 'filipino'], 'Thai': ['thai'],
  },
}

const SPELLINGS = { ...VOCABULARY, ...Object.assign({}, ...Object.values(PICKER_GROUPS)) }

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

// The matcher for one skill by name. A name the catalog no longer has (ticked
// before the list changed) is matched literally.
function matcherFor(name) {
  const spellings = SPELLINGS[name] || [escapeRegExp(String(name).toLowerCase())]
  return compile({ [name]: spellings })[0].re
}

// The ticked list as stored: names, unique, trimmed and bounded. It arrives
// from the renderer, so nothing about its shape is trusted.
function cleanSkills(list) {
  if (!Array.isArray(list)) return []
  const names = list.map(s => (typeof s === 'string' ? s.trim() : '')).filter(s => s && s.length <= 60)
  return [...new Set(names)].slice(0, 200)
}

// Each ticked skill this line names, as the text that matched ("SQL Server",
// "driver’s licence"), so a check can tell which words came from it.
function tickedIn(line, matchers) {
  const found = []
  for (const { re } of matchers) {
    const m = String(line).match(re)
    if (m) found.push(m[0].replace(/^[^\p{L}\p{N}+#.]/u, ''))
  }
  return found
}

const tickedMatchers = (names) => cleanSkills(names).map(name => ({ name, re: matcherFor(name) }))

module.exports = {
  REPORT_GROUPS, PICKER_GROUPS, VOCABULARY, compile, escapeRegExp, matcherFor, cleanSkills, tickedIn, tickedMatchers,
}
