/**
 * 对话示例（mes_example）解析 —— `<START>` 分块（需求 2：可多条）。
 *
 * 权威参考：SillyTavern script.js:3442 parseMesExamples
 * 与 openai.js:725 parseExampleIntoIndividual。
 * 本项目只走 Chat Completion，所以块首标记恒为 `<START>`。
 */

import type { PromptMessage } from '@/types/prompt'

/** 拆成块，每块以 `<START>\n` 开头 */
export function parseMesExamples(examplesStr: string): string[] {
  if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') return []
  let s = examplesStr
  if (!s.startsWith('<START>')) s = '<START>\n' + s.trim()
  return s
    .split(/<START>/gi)
    .slice(1) // 丢掉第一个 <START> 之前的空片段
    .map((block) => `<START>\n${block.trim()}\n`)
}

export interface ExampleNames {
  user: string
  char: string
  /** 1vN：所有成员名，用于识别 "Bob:" 开头的行 */
  members: string[]
  isGroup: boolean
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 一块 `<START>` → example_user / example_assistant 消息。
 * 前置条件：块内的 {{user}}/{{char}} 已经过宏替换。
 */
export function exampleBlockToMessages(block: string, names: ExampleNames): PromptMessage[] {
  const out: PromptMessage[] = []
  const lines = block
    .replace(/<START>/i, '{Example Dialogue:}')
    .replace(/\r/gm, '')
    .split('\n')

  let buf: string[] = []
  let curName = ''
  let isUserTurn = false

  const flush = () => {
    if (!buf.length) return
    let content = buf.join('\n')
    if (curName) {
      content = content.replace(new RegExp(`^${escapeRegex(curName)}\\s*:\\s*`), '')
    }
    content = content.trim()
    if (content) {
      out.push({
        role: 'system',
        name: isUserTurn ? 'example_user' : 'example_assistant',
        // 1vN 时给 AI 的示例回补发言者，模型才分得清谁在说话
        content: names.isGroup && !isUserTurn && curName ? `${curName}: ${content}` : content,
        source: 'dialogueExamples',
      })
    }
    buf = []
  }

  // 跳过第 0 行的 heading
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    if (names.user && line.startsWith(`${names.user}:`)) {
      flush()
      curName = names.user
      isUserTurn = true
    } else {
      const member = names.members.find((n) => n && line.startsWith(`${n}:`))
      if (member || (names.char && line.startsWith(`${names.char}:`))) {
        flush()
        curName = member ?? names.char
        isUserTurn = false
      }
    }
    buf.push(line)
  }
  flush()
  return out
}
