// Fake mnemon CLI used by the tests. Run as:
//   node tools/fixtures/fake-mnemon.mjs recall "<query>" --limit 3 --brief
// Behaviour is selected with FAKE_MNEMON_MODE: ok | empty | fail | slow.
// Kept outside test/ so the test runner does not execute it as a test file.
const mode = process.env.FAKE_MNEMON_MODE ?? 'ok'
const args = process.argv.slice(2)

if (mode === 'fail') {
  console.error('fake mnemon: deliberate failure')
  process.exit(2)
}

if (mode === 'slow') {
  await new Promise((resolve) => setTimeout(resolve, 5000))
}

const query = typeof args[1] === 'string' ? args[1] : ''

if (mode === 'empty') {
  console.log(JSON.stringify({ results: [] }))
  process.exit(0)
}

// Deliberate noise before the JSON payload: the adapter must tolerate it.
console.log('[fake-mnemon] warming')
console.log(
  JSON.stringify({
    results: [
      {
        id: '11111111-2222-3333-4444-555555555555',
        excerpt: `经验：${query.slice(0, 24)} 的既有做法与坑`,
        category: 'insight',
        score: 0.52,
        confidence: 'medium',
      },
      { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', excerpt: '低分噪音卡片', category: 'fact', score: 0.08 },
    ],
    detail_command: 'mnemon show <id>',
  }),
)
