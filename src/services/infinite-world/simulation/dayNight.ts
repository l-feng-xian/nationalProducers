import { MINUTES_PER_DAY } from '../core/constants'
import type { WorldSave } from '@/types/infiniteWorld'

export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night'
export const DAY_PHASE_LABEL: Record<DayPhase, string> = {
  dawn: '晨曦',
  day: '白昼',
  dusk: '黄昏',
  night: '月夜',
}
const clamp = (v: number) => Math.max(0, Math.min(1, v))
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}
export function dayPhase(minute: number): DayPhase {
  const m = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  return m < 300 || m >= 1200 ? 'night' : m < 420 ? 'dawn' : m < 1020 ? 'day' : 'dusk'
}
const KEYS: readonly { at: number; tint: [number, number, number] }[] = [
  { at: 0, tint: [0.15, 0.21, 0.37] },
  { at: 300, tint: [0.2, 0.25, 0.4] },
  { at: 360, tint: [0.53, 0.45, 0.46] },
  { at: 420, tint: [1, 0.86, 0.7] },
  { at: 570, tint: [1, 0.99, 0.95] },
  { at: 720, tint: [1, 1, 1] },
  { at: 960, tint: [1.02, 0.96, 0.85] },
  { at: 1050, tint: [1.04, 0.76, 0.52] },
  { at: 1110, tint: [0.62, 0.44, 0.43] },
  { at: 1200, tint: [0.2, 0.24, 0.39] },
  { at: 1440, tint: [0.15, 0.21, 0.37] },
]

/** One periodic time sample drives the sky, surfaces, lamps and projected shadows. */
export function sampleDayNight(minute: number, weather: WorldSave['weather'] = 'clear') {
  const m = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  let i = 0
  while (i < KEYS.length - 2 && KEYS[i + 1]!.at <= m) i++
  const a = KEYS[i]!,
    b = KEYS[i + 1]!,
    t = smooth(a.at, b.at, m)
  const weatherLight = weather === 'storm' ? 0.63 : weather === 'rain' ? 0.8 : 1
  const tint = a.tint.map((v, k) => (v + (b.tint[k]! - v) * t) * weatherLight) as [
    number,
    number,
    number,
  ]
  const angle = ((m - 360) / 720) * Math.PI
  const altitude = Math.sin(angle)
  const sun =
    smooth(0, 0.32, altitude) * (weather === 'clear' ? 1 : weather === 'rain' ? 0.4 : 0.16)
  // The sun travels east to west. Its projection stays bounded near the horizon.
  const shadow: [number, number] = [-Math.cos(angle) * 1.5, -0.22 - Math.max(0, altitude) * 0.2]
  return {
    minute: m,
    phase: dayPhase(m),
    tint,
    sun,
    shadow,
    shadowOpacity: 0.3 * sun,
    lamps: 1 - smooth(0.03, 0.3, altitude),
  }
}

/** Pause and reload preserve the same clock; no wall-clock catch-up on tab resume. */
export function createWorldClock(day: number, minute: number, dayMinutes = 20) {
  const duration = Number.isFinite(dayMinutes) && dayMinutes > 0 ? dayMinutes : 20
  return {
    get day() {
      return day
    },
    get minute() {
      return minute
    },
    step(seconds: number, paused = false) {
      if (paused || !Number.isFinite(seconds) || seconds <= 0) return
      const total = minute + (seconds * MINUTES_PER_DAY) / (duration * 60)
      day += Math.floor(total / MINUTES_PER_DAY)
      minute = total % MINUTES_PER_DAY
    },
  }
}
