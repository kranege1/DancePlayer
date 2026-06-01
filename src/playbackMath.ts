export function getFadeWindow(cueStartSec: number, targetPlaytimeSec: number, fadeOutSec: number) {
  const start = Math.max(0, cueStartSec)
  const end = start + Math.max(1, targetPlaytimeSec)
  const fade = Math.max(0.1, fadeOutSec)
  const fadeStart = Math.max(start, end - fade)
  return { start, end, fadeStart, fade }
}

export function getRepeatThirtyStart(currentTimeSec: number) {
  return Math.max(0, currentTimeSec - 30)
}
