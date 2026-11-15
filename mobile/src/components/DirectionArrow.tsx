import Svg, { Path } from 'react-native-svg';

import { ARROW_HALF_LENGTH_PX, ARROW_HEAD_PX, ARROW_SIDE_OFFSET_PX } from '../data/routeDirection';

/** The arrow's square, in px; its center is the spot on the line, and the arrow sits off to one side. */
export const DIRECTION_ARROW_BOX = 72;
/**
 * How far right of the line (facing the way it runs) the arrow is drawn: clear of the 8 px line
 * even where it strays a little toward the arrow (routeDirection.ts allows up to 6 px).
 */
const HALF = DIRECTION_ARROW_BOX / 2;
const HALF_LENGTH = ARROW_HALF_LENGTH_PX;
const HEAD = ARROW_HEAD_PX;

// A long arrow pointing up (the way the line runs once the box is turned to its bearing): a shaft
// with an open head, beside the line rather than on it, on whichever side routeDirection.ts found clear.
const arrowPath = (x: number) => `M${x} ${HALF + HALF_LENGTH} L${x} ${HALF - HALF_LENGTH} M${x - HEAD} ${HALF - HALF_LENGTH + HEAD} L${x} ${HALF - HALF_LENGTH} L${x + HEAD} ${HALF - HALF_LENGTH + HEAD}`;
const ARROWS = { right: arrowPath(HALF + ARROW_SIDE_OFFSET_PX), left: arrowPath(HALF - ARROW_SIDE_OFFSET_PX) };

/**
 * Which way the route runs, as an arrow in its color next to the line near the rider's stop (never
 * on the line or the stop). Unturned it points up; the map turns it to the line's bearing.
 */
export function DirectionArrow({ color, side = 'right' }: { color: string; side?: 'right' | 'left' }) {
  return (
    <Svg height={DIRECTION_ARROW_BOX} pointerEvents="none" viewBox={`0 0 ${DIRECTION_ARROW_BOX} ${DIRECTION_ARROW_BOX}`} width={DIRECTION_ARROW_BOX}>
      <Path d={ARROWS[side]} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} />
    </Svg>
  );
}
