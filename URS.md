# User Requirements Specification (URS) - Next Stage

This document outlines feature requirements and specifications planned for the next development stage of the DancePlayer PWA.

## 1. Persistent Tap History for Beat Alignment
* **Goal**: Enable users to refine a track's beat alignment over multiple sessions without losing previous tap data.
* **Specification**:
  - Extend the `Track` metadata structure in `src/types.ts` to include a `tapsHistory?: number[]` field.
  - When the user taps "Beat 1", store the new tap timestamp in the track's persistent `tapsHistory` array in local storage.
  - When loading a track, populate the React state list with the stored history if it exists.
  - The linear regression model should always run on the complete history of taps to continuously improve timing precision.

## 2. Advanced Tempo Drift / Variable BPM Support
* **Goal**: Support older recordings or live performances where the tempo shifts or drifts over time.
* **Specification**:
  - Define a multi-segment beat grid mapping where a song can have multiple tempo sections.
  - A track can be divided into time spans (segments) with individual phases and intervals:
    ```typescript
    interface TempoSegment {
      startSec: number;
      endSec: number;
      beat1Phase: number;
      beat1Interval: number;
    }
    ```
  - Use regression fitting locally within localized segments or a sliding window mechanism.
