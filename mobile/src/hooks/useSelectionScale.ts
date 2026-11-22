import { useEffect, useRef, useState } from 'react';
import { Easing } from 'react-native';

import { useAppSettings } from '../theme/AppSettings';

/** How long a tapped vehicle takes to grow, or shrink back once its popup closes. */
export const SELECT_MS = 300;
export const SELECTED_SCALE = 1.3;

// Quick to start and gentle to land, with no overshoot to bounce back from.
export const SELECT_BEZIER = [0.25, 0.7, 0.3, 1] as const;
export const selectionEasing = Easing.bezier(...SELECT_BEZIER);

/**
 * How far into its selected look a marker is: 0 plain, 1 selected, easing between the two when
 * `selected` changes. Jumps straight there with reduced motion.
 */
export function useSelectionScale(selected: boolean): number {
  const { reducedMotionActive } = useAppSettings();
  const target = selected ? 1 : 0;
  const shouldAnimate = !reducedMotionActive && typeof requestAnimationFrame === 'function';
  const [progress, setProgress] = useState(target);
  const progressRef = useRef(progress);

  // Keep the rendered scale and the next animation's starting point in sync when snapping.
  if (!shouldAnimate && progress !== target) {
    setProgress(target);
  }

  useEffect(() => {
    if (!shouldAnimate) {
      progressRef.current = target;
      return undefined;
    }
    const from = progressRef.current;
    if (from === target) return undefined;
    const startedAt = Date.now();
    let frame = 0;
    const step = () => {
      const t = Math.min(1, (Date.now() - startedAt) / SELECT_MS);
      const k = selectionEasing(t);
      const next = t >= 1 ? target : from + (target - from) * k;
      progressRef.current = next;
      setProgress(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [shouldAnimate, target]);
  return progress;
}
