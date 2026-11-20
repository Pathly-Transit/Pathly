import { nearestSnap, swipedTab } from '../src/components/TransitSheet';

describe('home sheet snapping', () => {
  const offsets = [0, 208, 900];

  it('settles a released sheet on the nearest of lowered, rest, and open', () => {
    expect(nearestSnap(90, offsets)).toBe(0);
    expect(nearestSnap(130, offsets)).toBe(208);
    expect(nearestSnap(500, offsets)).toBe(208);
    expect(nearestSnap(600, offsets)).toBe(900);
  });

  it('leaves the list alone once it is scrolled past open', () => {
    expect(nearestSnap(900, offsets)).toBeNull();
    expect(nearestSnap(1400, offsets)).toBeNull();
  });
});

describe('swiping between Nearby and Favorites', () => {
  const order = ['nearby', 'favorites'] as const;

  it('goes to the next tab on a swipe left and back on a swipe right', () => {
    expect(swipedTab('nearby', -80, 0, order)).toBe('favorites');
    expect(swipedTab('favorites', 80, 0, order)).toBe('nearby');
  });

  it('turns on a quick flick even when it is short', () => {
    expect(swipedTab('nearby', -20, -0.8, order)).toBe('favorites');
  });

  it('stays put on a short drag or past either end', () => {
    expect(swipedTab('nearby', -30, -0.1, order)).toBeNull();
    expect(swipedTab('nearby', 80, 0, order)).toBeNull();
    expect(swipedTab('favorites', -80, 0, order)).toBeNull();
  });
});
