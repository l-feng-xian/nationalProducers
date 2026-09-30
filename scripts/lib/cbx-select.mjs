/**
 * 通用下拉（CbxSelect）的自动化辅助。
 *
 * 它不是原生 <select>，不能用 selectOption：要先点开触发器，再点弹出的选项。
 * 桌面上选项渲染在就地浮层里，手机上是从底部升起、Teleport 到 body 的面板 ——
 * 两处都是 role="option"，所以统一按 role / data-value 找。
 */

/**
 * @param scope  含有该下拉的作用域（page 或某个 locator）
 * @param fieldLabel 下拉的无障碍名（= CbxSelect 的 label）
 * @param option 按值选 `{ value: 'json' }`，按显示文字选 `{ label: 'JSON image_urls · …' }`
 */
export async function pickOption(scope, fieldLabel, option) {
  await scope.getByLabel(fieldLabel, { exact: true }).click()
  const page = scope.page()
  if ('value' in option) {
    await page.locator(`[role="option"][data-value="${option.value}"]`).click()
    return
  }
  await page.getByRole('option', { name: option.label, exact: true }).click()
}

/** 当前选中项的文字（不打开浮层） */
export async function selectedText(scope, fieldLabel) {
  return (await scope.getByLabel(fieldLabel, { exact: true }).innerText()).trim()
}
