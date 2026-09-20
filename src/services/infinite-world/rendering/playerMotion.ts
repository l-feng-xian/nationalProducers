/** Animation clocks follow actual travel, including sliding collisions and torus crossings. */
export const WALK_STRIDE = 2.4
export const IDLE_CYCLE_SEC = 3

export function createPlayerMotion() {
  let gait = 0
  let idle = 0
  let moving = false
  return {
    step(dt: number, distance: number, paused = false) {
      if (!paused) {
        const nextMoving = distance > 1e-6
        if (nextMoving) {
          // Resume at a planted foot, instead of jumping to a global wall-clock frame.
          if (!moving) gait = 0
          gait = (gait + distance / WALK_STRIDE) % 1
          idle = 0
        } else {
          idle = (idle + dt / IDLE_CYCLE_SEC) % 1
        }
        moving = nextMoving
      }
      return { moving, phase: moving ? gait : idle }
    },
  }
}
