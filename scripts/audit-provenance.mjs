#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

const roots = git(['rev-list', '--max-parents=0', '--all']).split('\n').filter(Boolean)
const authors = [...new Set(git(['log', '--format=%an <%ae>', '--all']).split('\n').filter(Boolean))]
const messages = git(['log', '--format=%B', '--all'])
const remotes = git(['remote', '-v']).split('\n').filter(Boolean)
const allowed = new Set((process.env.DSH_CODEX_ALLOWED_AUTHORS ?? 'snowan <xiaowei.wan89@gmail.com>').split(';'))

const failures = []
if (roots.length !== 1) failures.push(`expected one independent Git root, found ${roots.length}`)
for (const author of authors) {
  if (!allowed.has(author)) failures.push(`unexpected commit author: ${author}`)
}
if (/co-authored-by:/iu.test(messages)) failures.push('commit history contains Co-authored-by trailers')
if (remotes.some(remote => /wingoo\/codex-plugin-dsh/iu.test(remote))) {
  failures.push('a rejected derivative repository is configured as a remote')
}

const report = { roots, authors, remotes, ok: failures.length === 0, failures }
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
