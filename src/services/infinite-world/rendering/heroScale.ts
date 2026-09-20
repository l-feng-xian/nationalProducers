/** Calibrate animation groups by opaque body height, ignoring chroma-key fringe. */
export function heroGroupScales(heights: ReadonlyMap<string, number>): Map<string, number> {
  const median = (values: number[]) => {
    values.sort((a, b) => a - b)
    return values.length ? values[Math.floor(values.length / 2)]! : 0
  }
  const target = heights.get('idle-down-0') ?? heights.get('hero-down') ?? 0
  const result = new Map<string, number>()
  if (!target) return result
  for (const direction of ['down', 'up', 'left', 'right']) {
    for (const action of ['walk', 'idle']) {
      const prefix = `${action}-${direction}-`
      const group = [...heights].filter(([name]) => name.startsWith(prefix))
      const height = median(group.map(([, h]) => h))
      // One transform for an entire gait; never resize to each frame's moving silhouette.
      if (height) for (const [name] of group) result.set(name, target / height)
    }
    const hero = `hero-${direction}`,
      height = heights.get(hero)
    if (height) result.set(hero, target / height)
  }
  return result
}
