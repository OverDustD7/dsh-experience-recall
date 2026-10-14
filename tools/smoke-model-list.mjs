// Real-endpoint smoke check for `/experience-recall model`'s listing half.
//
// Runs the same code path the command uses against the actual local Ollama, so
// the card's content and ordering are observed on this machine instead of being
// assumed from fixtures. Read-only: it never writes a profile.
import { buildModelQuestion, describeModel, listLocalModels, rankModels } from '../lib/models.js'

const endpoint = process.argv[2] ?? 'http://localhost:11434'
const listed = await listLocalModels({ endpoint, timeoutMs: 5000 })
if (listed.ok !== true) {
  console.log(`listing failed: ${listed.error}`)
  process.exit(1)
}
const ranked = rankModels(listed.models, process.env.SMOKE_CURRENT ?? '', { max: 20 })
const question = buildModelQuestion({
  current: process.env.SMOKE_CURRENT ?? '',
  endpoint,
  options: ranked.options,
  hidden: ranked.hidden,
  embeddings: ranked.embeddings,
})
console.log(`endpoint      ${endpoint}`)
console.log(`models         ${listed.models.length} total, ${ranked.options.length} offered, ${ranked.embeddings} embedding, ${ranked.hidden} hidden`)
for (const model of listed.models) {
  console.log(`  ${model.embedding ? 'embed' : 'chat '}  ${model.name.padEnd(34)} ${describeModel(model)}`)
}
console.log('--- card ---')
console.log(question.question)
console.log(question.detail ?? '')
for (const option of question.options) console.log(`  [${option.label}] ${option.description}`)
