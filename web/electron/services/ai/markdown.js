// Strip the markdown formatting models add despite being told not to.
//
// The output of this goes to employers, so the one thing it must never do is
// change the candidate's own text. It used to treat any `_x_` as italics, which
// rewrote jane_doe_smith@mail.com as janedoesmith@mail.com and
// github.com/jane_doe/my_repo as github.com/janedoe/myrepo — a résumé with
// contact details that do not work, sent to every employer, and nothing
// downstream checks contact details. Identifiers in a skills list
// (scikit_learn, __init__) were mangled the same way.
//
// So emphasis is only stripped where it is unambiguously emphasis:
//   - the markers sit at word boundaries (not inside a word, URL or address);
//   - underscore emphasis must wrap more than one word, because models use
//     `**`/`*` for emphasis and a single underscored token in a résumé is far
//     more likely to be a literal identifier than formatting. Leaving a stray
//     `_word_` is a cosmetic miss; deleting an underscore is a broken email.

// A marker can open emphasis only at the start of the text or after whitespace
// or an opening bracket/quote, and close it only before whitespace, the end, or
// punctuation. That keeps `a_b_c`, `x*y*z` and `path/_x_/` intact.
const OPEN = String.raw`(^|[\s(\["'])`
const CLOSE = String.raw`(?=$|[\s)\]"'.,;:!?])`

const BOLD_STARS = new RegExp(`${OPEN}\\*\\*(?!\\s)(.+?)(?<!\\s)\\*\\*${CLOSE}`, 'gm')
const ITALIC_STARS = new RegExp(`${OPEN}\\*(?![\\s*])([^*\\n]+?)(?<![\\s*])\\*${CLOSE}`, 'gm')
// Content must contain a space: "_Senior Engineer_" is emphasis, "_doe_" is not.
const BOLD_UNDERSCORES = new RegExp(`${OPEN}__(?!\\s)([^_\\n]*\\s[^_\\n]*?)(?<!\\s)__${CLOSE}`, 'gm')
const ITALIC_UNDERSCORES = new RegExp(`${OPEN}_(?![\\s_])([^_\\n]*\\s[^_\\n]*?)(?<![\\s_])_${CLOSE}`, 'gm')

// There used to be two copies of this function, and the one the applicator
// used had two more ways to lose the candidate's text: it DELETED fenced code
// blocks — so a model that wrapped the whole résumé in ``` returned an empty
// one — and it reduced [LinkedIn](https://linkedin.com/in/jane) to "LinkedIn",
// dropping the only part an employer can use. Fences are now unwrapped and a
// link keeps its address.
function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')  // ```lang … ``` → its contents
    .replace(/`([^`\n]+)`/g, '$1')                // inline code
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, url) => (
      label.trim() === url || url.endsWith(label.trim()) ? url : `${label} (${url})`
    ))
    .replace(/^\s*>\s?/gm, '')          // > blockquotes
    .replace(/^#{1,6}\s+/gm, '')        // ## headings → plain
    .replace(/^-{3,}\s*$/gm, '')        // --- dividers → removed
    // Bullets before emphasis, so "* Led the team" is not read as the opening
    // half of an italic span.
    .replace(/^(\s*)\*\s+/gm, '$1- ')   // * bullets → -
    .replace(BOLD_STARS, '$1$2')
    .replace(BOLD_UNDERSCORES, '$1$2')
    .replace(ITALIC_STARS, '$1$2')
    .replace(ITALIC_UNDERSCORES, '$1$2')
    .replace(/\n{3,}/g, '\n\n')         // collapse excessive newlines
    .trim()
}

module.exports = { stripMarkdown }
