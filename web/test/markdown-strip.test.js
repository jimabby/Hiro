// stripMarkdown runs over every tailored résumé and cover letter before it is
// submitted, so it must remove formatting without ever changing the candidate's
// own text. It used to delete underscores (jane_doe_smith@mail.com went out as
// janedoesmith@mail.com), delete fenced blocks outright, and drop link URLs.
// The applicator tests stub it, so this suite is the only thing that runs it.

const { createChecker } = require('./helpers')
const { stripMarkdown } = require('../electron/services/ai/markdown')
const utils = require('../electron/services/scraper/utils')

const { check, done } = createChecker()

// ─── The candidate's text is never changed ───────────────────────
check('an underscored email survives', stripMarkdown('Email: jane_doe_smith@mail.com'), 'Email: jane_doe_smith@mail.com')
check('an underscored URL survives', stripMarkdown('github.com/jane_doe/my_repo'), 'github.com/jane_doe/my_repo')
check('identifiers survive', stripMarkdown('Python, scikit_learn, snake_case_utils, __init__ methods'), 'Python, scikit_learn, snake_case_utils, __init__ methods')
check('a lone underscored token is left alone', stripMarkdown('handle _jdoe_ on GitHub'), 'handle _jdoe_ on GitHub')
check('arithmetic stars survive', stripMarkdown('a 3*4 grid and 2 * 5'), 'a 3*4 grid and 2 * 5')
check('a star inside a word survives', stripMarkdown('C*-algebras'), 'C*-algebras')

// ─── Real formatting is still removed ────────────────────────────
check('bold stars', stripMarkdown('**Senior Engineer** at Acme'), 'Senior Engineer at Acme')
check('italic stars', stripMarkdown('I am *very* keen.'), 'I am very keen.')
check('multi-word underscore italics', stripMarkdown('_Senior Data Engineer_, 2021'), 'Senior Data Engineer, 2021')
check('multi-word underscore bold', stripMarkdown('__Key Skills__'), 'Key Skills')
check('headings', stripMarkdown('## Experience\nAcme'), 'Experience\nAcme')
check('star bullets become dashes', stripMarkdown('* Led the team\n* Shipped *fast*'), '- Led the team\n- Shipped fast')
check('dividers removed', stripMarkdown('A\n---\nB'), 'A\n\nB')
check('blockquotes unwrapped', stripMarkdown('> Dear Hiring Manager'), 'Dear Hiring Manager')
check('inline code unwrapped', stripMarkdown('Used `kubectl` daily'), 'Used kubectl daily')

// ─── Nothing is thrown away ──────────────────────────────────────
check('a fenced résumé is unwrapped, not deleted', stripMarkdown('```\nJane Doe\nEngineer\n```'), 'Jane Doe\nEngineer')
check('a fence with a language tag too', stripMarkdown('```text\nJane Doe\n```'), 'Jane Doe')
check('a link keeps its address', stripMarkdown('[LinkedIn](https://linkedin.com/in/jane)'), 'LinkedIn (https://linkedin.com/in/jane)')
check('a bare link is not doubled', stripMarkdown('[https://jane.dev](https://jane.dev)'), 'https://jane.dev')

// ─── Edge input ──────────────────────────────────────────────────
check('null is empty', stripMarkdown(null), '')
check('undefined is empty', stripMarkdown(undefined), '')

// ─── One implementation ──────────────────────────────────────────
check('the scraper utilities use the same function', utils.stripMarkdown, stripMarkdown)

done()
