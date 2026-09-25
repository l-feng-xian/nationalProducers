/**
 * 群聊「@ 优先发言」验证。
 *
 * 跑法： npm run verify:group-mentions
 *
 * 钉死两件事：① 从用户消息里认出哪些人被 @、按什么顺序；
 * ② 四种激活策略下，被 @ 的人都排在最前（轮流 / 手动只由被 @ 的人回复）。
 */

import { explicitMentions, selectSpeakers } from '@/services/group/activation'
import { group_activation_strategy, type Group, type GroupActivationStrategy } from '@/types/group'
import type { Character } from '@/types/character'
import type { ChatMessage } from '@/types/chat'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else failed++
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

function char(id: string, name: string, talkativeness = 0): Character {
  return { id, data: { name, extensions: { talkativeness } } } as unknown as Character
}

// 爱丽丝 / Bob / 白 / 白夜 / 静音的「影」。talkativeness 全 0：自然策略不会随机多拉人，结果可断言
const cast = [
  char('a', '爱丽丝'),
  char('b', 'Bob'),
  char('w', '白'),
  char('y', '白夜'),
  char('s', '影'),
]
const charById = new Map(cast.map((c) => [c.id, c]))

function group(strategy: GroupActivationStrategy): Group {
  return {
    members: cast.map((c) => c.id),
    disabled_members: ['s'],
    activation_strategy: strategy,
    allow_self_responses: false,
  } as unknown as Group
}

const userMsg = (mes: string) => ({ is_user: true, name: '我', mes }) as unknown as ChatMessage

function speakers(strategy: GroupActivationStrategy, text: string, isUserInput = true) {
  return selectSpeakers({
    group: group(strategy),
    charById,
    chat: [userMsg(text)],
    isUserInput,
    activationText: isUserInput ? text : '',
  })
}

const eq = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b)

// ── 识别 ──
const g = group(group_activation_strategy.NATURAL)
const m = (t: string) => explicitMentions(t, g, charById)
check(
  '按 @ 先后排序',
  eq(m('@Bob 和 @爱丽丝 过来'), ['b', 'a']),
  JSON.stringify(m('@Bob 和 @爱丽丝 过来')),
)
check('最长名优先：@白夜 不是 @白', eq(m('@白夜 你好'), ['y']))
check('@白 单独也能认出', eq(m('@白 你好'), ['w']))
check('大小写不敏感', eq(m('@bob hi'), ['b']))
check('邮箱不算', eq(m('mail bob@Bob.com'), []))
check('重复 @ 去重', eq(m('@Bob @Bob'), ['b']))
check('不是成员名不算', eq(m('@路人 你好'), []))
check('只写名字、不带 @ 不算显式 @', eq(m('Bob 你好'), []))
check('静音成员被 @ 也算', eq(m('@影 出来'), ['s']))

// ── 四种策略 ──
const N = group_activation_strategy.NATURAL
const L = group_activation_strategy.LIST
const P = group_activation_strategy.POOLED
const M = group_activation_strategy.MANUAL

const natural = speakers(N, '@白夜 说说看')
check('自然：被 @ 的人第一个发言', natural[0] === 'y', JSON.stringify(natural))

const list = speakers(L, '@白夜 @Bob 说说看')
check(
  '列表：被 @ 的按 @ 顺序排前，其余照列表接上、不重复',
  eq(list, ['y', 'b', 'a', 'w']),
  JSON.stringify(list),
)

for (let i = 0; i < 20; i++) {
  const pooled = speakers(P, '@Bob 你怎么看')
  if (!eq(pooled, ['b'])) {
    check('轮流：只由被 @ 的人回复', false, JSON.stringify(pooled))
    break
  }
  if (i === 19) check('轮流：只由被 @ 的人回复（20 次）', true)
}

check('手动：用户 @ 后被 @ 的人回复', eq(speakers(M, '@爱丽丝 @Bob 在吗'), ['a', 'b']))
check('手动：没有 @ 仍不自动回复', eq(speakers(M, '在吗'), []))
check('静音成员被 @ 也会发言', speakers(N, '@影 出来')[0] === 's')

// ── 不该生效的场景 ──
check('列表：没有 @ 时顺序不变', eq(speakers(L, '大家好'), ['a', 'b', 'w', 'y']))
check('自动续聊（非用户输入）不看 @', eq(speakers(L, '@白夜', false), ['a', 'b', 'w', 'y']))
check(
  'forceId 仍然优先于 @',
  eq(
    selectSpeakers(
      {
        group: group(L),
        charById,
        chat: [userMsg('@Bob')],
        isUserInput: true,
        activationText: '@Bob',
      },
      'a',
    ),
    ['a'],
  ),
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
