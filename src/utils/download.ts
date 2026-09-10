/**
 * 浏览器下载 + 文件名清洗。
 * 仓里原本有三份复制的 createObjectURL/click/revoke，统一到这里。
 * 本文件不 import vue/pinia，可被 services 与 views 共用。
 */

/** Windows 保留设备名，带任何扩展名都不能创建 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
/** 单段文件名的字符数上限（NTFS 是 255 字节，中文按 3 字节算留足余量） */
const MAX_NAME_CHARS = 64

/**
 * 角色名 → 安全文件名。
 * 处理：控制字符、Windows 非法字符、纯空白名、首尾点与空格、
 * 重复扩展名（角色就叫「铃.png」时不要产出 铃.png.png）、保留设备名、超长。
 * emoji 三大 OS 都合法，**刻意不剥离**。
 */
export function safeFileName(raw: string, ext: string, fallback = 'character'): string {
  const dot = '.' + ext.replace(/^\./, '')
  // eslint-disable-next-line no-control-regex -- 控制字符正是要清掉的东西
  let s = (raw ?? '').replace(/[\x00-\x1f\x7f]/g, '')
  // / 与 \ 不报错，浏览器会静默替换或吞掉，自己换成 _ 用户才看得懂
  s = s.replace(/[/\\:*?"<>|]/g, '_')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (s.toLowerCase().endsWith(dot.toLowerCase())) {
    s = s.slice(0, s.length - dot.length).trim()
  }
  // 按码点截断，slice 会劈开代理对产出半个 emoji
  const chars = Array.from(s)
  if (chars.length > MAX_NAME_CHARS) s = chars.slice(0, MAX_NAME_CHARS).join('').trim()
  if (!s || WIN_RESERVED.test(s)) s = fallback
  return s + dot
}

/** 触发一次浏览器下载。anchor 必须挂进 document，游离 anchor 的合成 click 在部分内核上无效 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 不要用 setTimeout(1000)：危险窗口是「点击后下载还没开始」
  // （Chrome 的保存位置对话框、iOS Safari 的下载确认弹窗都能开很久）
  const revoke = () => {
    window.removeEventListener('pagehide', revoke)
    URL.revokeObjectURL(url)
  }
  window.addEventListener('pagehide', revoke)
  setTimeout(revoke, 60000)
}
