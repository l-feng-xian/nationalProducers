/** Derive restrained surface relief from painted sprites without changing their colour/alpha. */
export function spriteNormalPixels(rgba: Uint8Array, sourceSize: number, name: string, size = 128) {
  const n = size * size,
    alpha = new Float32Array(n),
    luminance = new Float32Array(n)
  let left = size,
    right = 0,
    top = size,
    bottom = 0
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x,
        s =
          (Math.min(sourceSize - 1, Math.floor(((y + 0.5) * sourceSize) / size)) * sourceSize +
            Math.min(sourceSize - 1, Math.floor(((x + 0.5) * sourceSize) / size))) *
          4
      alpha[i] = rgba[s + 3]! / 255
      luminance[i] = (rgba[s]! * 0.2126 + rgba[s + 1]! * 0.7152 + rgba[s + 2]! * 0.0722) / 255
      if (alpha[i]! > 0.5) {
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
  // Blur the paint luminance before differentiating; outlines must not turn into glowing ridges.
  let light = luminance
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(n)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let sum = 0,
          weight = 0
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const j =
              Math.max(0, Math.min(size - 1, y + dy)) * size +
              Math.max(0, Math.min(size - 1, x + dx))
            const a = alpha[j]!
            sum += light[j]! * a
            weight += a
          }
        next[y * size + x] = weight > 0 ? sum / weight : light[y * size + x]!
      }
    light = next
  }
  const tree = /oak|birch|bush|tree/.test(name)
  const building = /cottage|house|inn|shop|barn|workshop|well/.test(name)
  const out = new Uint8Array(n * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const nx = (x - (left + right) / 2) / Math.max(1, (right - left) / 2)
      const ny = ((top + bottom) / 2 - y) / Math.max(1, (bottom - top) / 2)
      const height = (bottom - y) / Math.max(1, bottom - top)
      let vx = nx * (tree ? 0.7 : building ? 0.28 : 0.44),
        vy = 0.22 + ny * (tree ? 0.48 : 0.28)
      if (building && height > 0.48) {
        // Broad gable planes; retain the painted roof tiles as small-scale relief.
        vx = Math.tanh(nx * 6) * 0.64
        vy = 0.58
      }
      const at = (xx: number, yy: number) =>
        light[Math.max(0, Math.min(size - 1, yy)) * size + Math.max(0, Math.min(size - 1, xx))]!
      vx += Math.max(-0.18, Math.min(0.18, (at(x - 2, y) - at(x + 2, y)) * 0.85))
      vy += Math.max(-0.18, Math.min(0.18, (at(x, y + 2) - at(x, y - 2)) * 0.85))
      const vz = Math.sqrt(Math.max(0.15, 1 - vx * vx - vy * vy)),
        length = Math.hypot(vx, vy, vz)
      out[i * 4] = Math.round(((vx / length) * 0.5 + 0.5) * 255)
      out[i * 4 + 1] = Math.round(((vy / length) * 0.5 + 0.5) * 255)
      out[i * 4 + 2] = Math.round(((vz / length) * 0.5 + 0.5) * 255)
      out[i * 4 + 3] = 255
    }
  return out
}
