// The skills the user ticked in Settings as true though no résumé lists them
// (config.extraSkills; see prompts.js extraSkillsNote). Read when a prompt is
// built, the way local.js reads its server address, so that every call site
// picks them up without passing them along. A config that cannot be read means
// none ticked, never a failed call.
const { cleanSkills } = require('../skillCatalog')

module.exports = function tickedSkills() {
  try { return cleanSkills(require('../config').load().extraSkills) } catch { return [] }
}
