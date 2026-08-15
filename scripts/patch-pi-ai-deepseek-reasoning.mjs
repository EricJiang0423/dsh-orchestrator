/**
 * Re-apply the cross-provider reasoning_content fix on installed packages.
 *
 * Bug: https://github.com/deepseek-ai/deepseek-harness/discussions/1146
 *
 * When pi-ai's DeepSeek route replays assistant history produced by another
 * provider, `reasoning` blocks are converted to pi-ai `thinking` blocks without
 * a `thinkingSignature`. pi-ai's OpenAI Chat Completions serialiser only emits
 * `reasoning_content` when that signature is present, and its transform layer
 * additionally downgrades foreign `thinking` blocks to plain text. DeepSeek
 * thinking-mode backends then reject the request with 400:
 * "The `reasoning_content` in the thinking mode must be passed back to the API."
 *
 * This script patches the two installed packages in node_modules:
 *   - @deepseek-ai/dsh-llm-pi-ai/lib/index.js
 *   - @earendil-works/pi-ai/dist/api/transform-messages.js
 *
 * It is idempotent: if the markers are already present it leaves the file alone.
 * Run it manually after `npm install` (optional argument: the project root whose
 * node_modules should be patched), or let the `postinstall` script call it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = process.argv[2] ? resolve(process.argv[2]) : dirname(dirname(fileURLToPath(import.meta.url)))

const targets = [
  {
    path: join(root, 'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),
    replacements: [
      {
        from: `\t\tcase "reasoning":
\t\t\tcontent.push({
\t\t\t\ttype: "thinking",
\t\t\t\tthinking: block.text
\t\t\t});
\t\t\tbreak;`,
        to: `\t\tcase "reasoning":
\t\t\tcontent.push({
\t\t\t\ttype: "thinking",
\t\t\t\tthinking: block.text,
\t\t\t\tthinkingSignature: "reasoning_content"
\t\t\t});
\t\t\tbreak;`,
        marker: 'thinkingSignature: "reasoning_content"',
      },
      {
        from: `...replay.type === "reasoning" && replay.thinkingSignature !== void 0 ? { thinkingSignature: replay.thinkingSignature } : {}`,
        to: `...replay.type === "reasoning" ? { thinkingSignature: replay.thinkingSignature ?? "reasoning_content" } : {}`,
        marker: 'replay.thinkingSignature ?? "reasoning_content"',
      },
    ],
  },
  {
    path: join(root, 'node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js'),
    replacements: [
      {
        from: `                    if (isSameModel)
                        return block;
                    return {
                        type: "text",
                        text: block.thinking,
                    };`,
        to: `                    if (isSameModel)
                        return block;
                    if (model.compat?.requiresReasoningContentOnAssistantMessages && block.thinkingSignature) {
                        return block;
                    }
                    return {
                        type: "text",
                        text: block.thinking,
                    };`,
        marker: 'requiresReasoningContentOnAssistantMessages && block.thinkingSignature',
      },
    ],
  },
]

let patched = 0
let skipped = 0
let missing = 0
let failed = 0

for (const target of targets) {
  let source
  try {
    source = readFileSync(target.path, 'utf8')
  } catch {
    console.warn(`[patch-pi-ai] not found: ${target.path}`)
    missing += 1
    continue
  }
  let next = source
  let changed = false
  for (const replacement of target.replacements) {
    if (next.includes(replacement.marker)) continue
    if (!next.includes(replacement.from)) {
      console.error(`[patch-pi-ai] pattern not found: ${target.path} — the package version likely changed; re-derive the anchors`)
      failed += 1
      continue
    }
    next = next.replace(replacement.from, replacement.to)
    changed = true
  }
  if (changed) {
    writeFileSync(target.path, next, 'utf8')
    console.log(`[patch-pi-ai] patched: ${target.path}`)
    patched += 1
  } else {
    skipped += 1
  }
}

console.log(`[patch-pi-ai] done: ${patched} patched, ${skipped} already-fine, ${missing} missing, ${failed} failed`)
// A missing file is tolerated (the patched provider may be optional in some
// installs), but a file whose anchors no longer match means the patch silently
// stopped applying — fail the install so CI and local dev both notice.
if (failed > 0) process.exitCode = 1
