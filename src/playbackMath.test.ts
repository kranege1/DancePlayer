import { describe, expect, it } from 'vitest'
import { getFadeWindow, getRepeatThirtyStart } from './playbackMath'

describe('playback math', () => {
  it('calculates fade window boundaries', () => {
    const result = getFadeWindow(12, 90, 4)
    expect(result.start).toBe(12)
    expect(result.end).toBe(102)
    expect(result.fadeStart).toBe(98)
    expect(result.fade).toBe(4)
  })

  it('clamps repeat 30 to zero', () => {
    expect(getRepeatThirtyStart(20)).toBe(0)
    expect(getRepeatThirtyStart(45)).toBe(15)
  })
})
