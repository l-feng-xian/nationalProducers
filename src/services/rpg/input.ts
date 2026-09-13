/**
 * 输入层：键盘与虚拟摇杆归一化成同一个方向向量。
 *
 * 游戏主循环只读 `direction()`，不关心这一帧的输入是键盘还是手指 ——
 * 于是移动端与桌面端共用同一套移动逻辑。
 *
 * 纯 service：不 import vue/pinia。
 */

/** 方向向量，各分量 -1..1，长度已归一化（斜向不会比直行快） */
export interface Direction {
  x: number
  y: number
  /** 有没有输入。用来切 idle/walk */
  active: boolean
}

export interface InputHandle {
  direction(): Direction
  /** 虚拟摇杆把自己的向量喂进来，各分量 -1..1 */
  setStick(x: number, y: number): void
  /** 交互键（对话 / 采集）。读一次就清掉，避免一次按键触发多帧 */
  consumeInteract(): boolean
  /**
   * 数字键选工具，返回 1..9（没按返回 null）。读一次就清掉。
   *
   * 返回的是**人看到的槽位号**（从 1 起）而不是下标：快捷栏上印的就是 1..7，
   * 在这里减一会让「屏幕上的 3」与代码里的 3 不是一回事，早晚差一格。
   */
  consumeSlot(): number | null
  dispose(): void
}

const KEY_MAP: Record<string, [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
}

const INTERACT_KEYS = new Set(['KeyE', 'Space', 'Enter'])

export function createInput(): InputHandle {
  const held = new Set<string>()
  let stickX = 0
  let stickY = 0
  let interact = false
  let slot: number | null = null

  const onKeyDown = (e: KeyboardEvent): void => {
    // 正在输入框里打字时不要吞按键 —— 对话面板有输入框
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (KEY_MAP[e.code]) {
      held.add(e.code)
      e.preventDefault() // 方向键会滚动页面
      return
    }
    if (INTERACT_KEYS.has(e.code)) {
      interact = true
      e.preventDefault()
      return
    }
    // 数字键选工具。主键盘与小键盘都认 —— 笔记本外接键盘用小键盘的人不少
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)
    if (digit) {
      slot = Number(digit[1])
      e.preventDefault()
    }
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    held.delete(e.code)
  }
  /**
   * 失焦必须清空按键。
   * 不清的话：按着 D 切走标签页 → keyup 永远收不到 → 回来时角色一直往右走，
   * 而且怎么按都停不下来。桌面上很容易碰到。
   */
  const onBlur = (): void => {
    held.clear()
    stickX = 0
    stickY = 0
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  return {
    direction() {
      let x = 0
      let y = 0
      for (const code of held) {
        const d = KEY_MAP[code]
        if (!d) continue
        x += d[0]
        y += d[1]
      }
      // 摇杆与键盘叠加，谁大听谁的
      if (Math.abs(stickX) > Math.abs(x)) x = stickX
      if (Math.abs(stickY) > Math.abs(y)) y = stickY

      const len = Math.hypot(x, y)
      if (len < 0.08) return { x: 0, y: 0, active: false }
      // 归一化：不做的话斜向走会比直行快 √2 倍
      return { x: x / len, y: y / len, active: true }
    },
    setStick(x, y) {
      stickX = x
      stickY = y
    },
    consumeInteract() {
      const v = interact
      interact = false
      return v
    },
    consumeSlot() {
      const v = slot
      slot = null
      return v
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      held.clear()
    },
  }
}
