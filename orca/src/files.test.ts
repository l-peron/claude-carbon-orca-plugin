// Finding a session's transcripts on disk, and reading them a piece at a time.
import { chmod, rm, writeFile } from 'node:fs/promises'
import { assert, test } from 'orca/testing'
import { mergeRows, parseTranscript } from './carbon/transcript.ts'
import { findTranscripts, listAllSessions } from './files.ts'
import { append, assistant, PROJECT, put, tempDir } from './fixtures.ts'
import { readSession, TranscriptReader } from './reader.ts'

const SID = '0b80649f-a7c4-4d71-8bf1-755d5a1c95c4'
const usage = { input_tokens: 10, output_tokens: 10 }

test('a session is its transcript, its subagents and the agents its workflows started', async () => {
  const dir = await tempDir()
  await put(dir, `${PROJECT}/${SID}.jsonl`, [assistant('a', 'claude-opus-5-5', usage)])
  await put(dir, `${PROJECT}/${SID}/subagents/agent-1.jsonl`, [assistant('b', 'claude-opus-5-5', usage)])
  await put(dir, `${PROJECT}/${SID}/subagents/workflows/wf_1/agent-2.jsonl`, [assistant('c', 'claude-opus-5-5', usage)])
  // A workflow's journal carries no usage, and a folder without a main transcript is no session.
  await put(dir, `${PROJECT}/${SID}/subagents/workflows/wf_1/journal.jsonl`, ['{}'])
  await put(dir, `${PROJECT}/orphan/subagents/agent-9.jsonl`, [assistant('d', 'claude-opus-5-5', usage)])

  const files = await findTranscripts(dir, SID)
  assert.deepEqual(
    files.map((f) => f.path.slice(dir.length)),
    [
      `/${PROJECT}/${SID}.jsonl`,
      `/${PROJECT}/${SID}/subagents/agent-1.jsonl`,
      `/${PROJECT}/${SID}/subagents/workflows/wf_1/agent-2.jsonl`
    ]
  )
  const all = await listAllSessions(dir)
  assert.deepEqual(all.map((s) => [s.sessionId, s.files.length]), [[SID, 3]])
  assert.deepEqual(await findTranscripts(dir, '../etc'), [])
  assert.deepEqual(await listAllSessions(`${dir}/missing`), [])
  await rm(dir, { recursive: true, force: true })
})

test('a growing transcript read in pieces gives what one full read gives', async () => {
  const dir = await tempDir()
  const lines = [
    assistant('a', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 1 }),
    // A later snapshot of message a, in the next piece.
    assistant('a', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 50 }),
    assistant('b', 'claude-haiku-4-5', { input_tokens: 5, cache_read_input_tokens: 700, output_tokens: 5 })
  ]
  const path = await put(dir, `${PROJECT}/${SID}.jsonl`, [lines[0]])
  const reader = new TranscriptReader()
  await readSession(reader, await findTranscripts(dir, SID))
  // Half a line, as Claude Code is writing it: not counted, read again once whole.
  await writeFile(path, `${lines[0]}\n${lines[1].slice(0, 20)}`)
  await readSession(reader, await findTranscripts(dir, SID))
  await writeFile(path, `${lines[0]}\n${lines[1]}\n`)
  await append(path, [lines[2]])
  const pieces = await readSession(reader, await findTranscripts(dir, SID))
  const whole = mergeRows(parseTranscript(lines.join('\n'), 'x'))
  assert.deepEqual(pieces.rows, whole)
  assert.equal(pieces.cwd, '/Users/me/repo')
  // A file rewritten shorter is read again from its start.
  await writeFile(path, `${lines[2]}\n`)
  const again = await readSession(reader, await findTranscripts(dir, SID))
  assert.deepEqual(again.rows, mergeRows(parseTranscript(lines[2], 'x')))
  await rm(dir, { recursive: true, force: true })
})

test('an unreadable or corrupt file costs only itself', async () => {
  const dir = await tempDir()
  await put(dir, `${PROJECT}/${SID}.jsonl`, [
    '{"type":"assistant", not json',
    assistant('a', 'claude-opus-5-5', usage),
    '[1,2,3]'
  ])
  const locked = await put(dir, `${PROJECT}/${SID}/subagents/agent-1.jsonl`, [assistant('b', 'claude-opus-5-5', usage)])
  await chmod(locked, 0)
  const read = await readSession(new TranscriptReader(), await findTranscripts(dir, SID))
  assert.equal(read.rows.length, 1)
  assert.equal(read.rows[0].tokens.input, 10)
  assert.deepEqual(read.failed, [locked])
  await chmod(locked, 0o644)
  await rm(dir, { recursive: true, force: true })
})
