import { useEffect, useRef, useState } from 'react';

import { useAppSettings } from '../theme/AppSettings';

/** How long a tapped vehicle takes to grow, or shrink back once its popup closes. */
export const SELECT_MS = 260;

// Quick to start and gentle to land, with no overshoot to bounce back from.
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * How far into its selected look a marker is: 0 plain, 1 selected, easing between the two when
 * `selected` changes. Jumps straight there with reduced motion.
 */
export function useSelectionScale(selected: boolean): number {
  const { reducedMotionActive } = useAppSettings();
  const [progress, setProgress] = useState(selected ? 1 : 0);
  const progressRef = useRef(progress);
  useEffect(() => {
    const target = selected ? 1 : 0;
    const from = progressRef.current;
    if (from === target) return undefined;
    if (reducedMotionActive || typeof requestAnimationFrame !== 'function') {
      progressRef.current = target;
      setProgress(target);
      return undefined;
    }
    const startedAt = Date.now();
    let frame = 0;
    const step = () => {
      const t = Math.min(1, (Date.now() - startedAt) / SELECT_MS);
      const k = easeOutCubic(t);
      const next = t >= 1 ? target : from + (target - from) * k;
      progressRef.current = next;
      setProgress(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [reducedMotionActive, selected]);
  return progress;
}
