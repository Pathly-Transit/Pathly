const TRANSIT_TABS_HEIGHT = 30;
const TRANSIT_CARD_HEIGHT = 104;
const VISIBLE_TRANSIT_CARDS = 3;
const VISIBLE_CARD_GUTTER = 24;
const MINIMUM_MAP_HEIGHT = 240;

/**
 * How much lower than its resting height the home sheet can be dragged: two transit cards' worth
 * of map, leaving the tabs and one card showing. The sheet still opens at rest; the map is drawn
 * this much taller to fill the gap.
 */
export const SHEET_LOWER_DROP = TRANSIT_CARD_HEIGHT * 2;

/**
 * How much map shows above a resting sheet: the home screen's, sized so its sheet fits three
 * transit cards, and never under half the screen, so a short phone still gets a real map. Every
 * map page uses it, so the sheet rests at the same height everywhere.
 */
export function mapPageMapHeight(windowHeight: number): number {
  return Math.max(MINIMUM_MAP_HEIGHT, Math.round(windowHeight / 2), windowHeight - TRANSIT_TABS_HEIGHT - TRANSIT_CARD_HEIGHT * VISIBLE_TRANSIT_CARDS - VISIBLE_CARD_GUTTER);
}
