/**
 * 运行时环境判定：Tauri 原生壳（桌面 / 安卓）还是普通浏览器。
 *
 * 两个全局都要看：`__TAURI_INTERNALS__` 是 v2 注入的，`__TAURI__` 只有在开了
 * `withGlobalTauri` 时才有（也是 v1 的那个）。**不要嗅探 UA** —— 安卓 WebView 的
 * UA 和 Chrome 几乎一样，判不出是不是在壳里。
 */
export const isTauri: boolean =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

export const isWeb = !isTauri
