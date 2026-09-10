import { fnv1a } from '@/services/hash'

/**
 * characterId → 1..8 的角色区分色索引（对应 --cbx-char-1..8）。
 * 1vN 里靠它给不同角色的气泡加左边框，一眼分清谁在说话。
 * 禁止在组件里写死颜色。
 */
export function accentOf(characterId: string | undefined): number | undefined {
  if (!characterId) return undefined
  return (fnv1a(characterId) % 8) + 1
}
