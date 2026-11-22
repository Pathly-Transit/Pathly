import { useSyncExternalStore } from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { Animated } from 'react-native';

import { sheetPaddingExtra, useScrollSheetInset } from '../src/map/mapSheetInset';

it('publishes whole-pixel sheet changes to map subscribers without resizing the map', () => {
  const scroll = new Animated.Value(120);
  const { result } = renderHook(() => {
    const inset = useScrollSheetInset(scroll, 400, 120);
    const covered = useSyncExternalStore(inset.subscribe, inset.get);
    return { inset, covered };
  });
  const notify = jest.fn();
  const unsubscribe = result.current.inset.subscribe(notify);
  expect(result.current.covered).toBe(120);
  act(() => scroll.setValue(120.2));
  expect(notify).not.toHaveBeenCalled();
  act(() => scroll.setValue(121.4));
  expect(result.current.covered).toBe(121);
  expect(notify).toHaveBeenCalledTimes(1);
  act(() => scroll.setValue(900));
  expect(result.current.covered).toBe(400);
  // Even a fully expanded sheet preserves the camera's minimum visible map area.
  expect(sheetPaddingExtra(result.current.covered, 500, 40, 20)).toBe(280);
  unsubscribe();
});

it('updates the size cap with a stable store and retains the actual scrolled position', () => {
  const scroll = new Animated.Value(350);
  const { result, rerender } = renderHook(({ maximum }: { maximum: number }) => {
    const inset = useScrollSheetInset(scroll, maximum, 350);
    return { inset, covered: useSyncExternalStore(inset.subscribe, inset.get) };
  }, { initialProps: { maximum: 400 } });
  const originalStore = result.current.inset;
  rerender({ maximum: 200 });
  expect(result.current.inset).toBe(originalStore);
  expect(result.current.covered).toBe(200);
  rerender({ maximum: 500 });
  expect(result.current.covered).toBe(350);
  act(() => scroll.setValue(-50));
  expect(result.current.covered).toBe(0);
});

it('detaches old animation sources and removes its listener on unmount', () => {
  const oldScroll = new Animated.Value(0);
  const nextScroll = new Animated.Value(0);
  const removeOld = jest.spyOn(oldScroll, 'removeListener');
  const removeNext = jest.spyOn(nextScroll, 'removeListener');
  const { result, rerender, unmount } = renderHook(({ scroll }: { scroll: Animated.Value }) => useScrollSheetInset(scroll, 400), { initialProps: { scroll: oldScroll } });
  const notify = jest.fn();
  result.current.subscribe(notify);
  rerender({ scroll: nextScroll });
  expect(removeOld).toHaveBeenCalledTimes(1);
  act(() => oldScroll.setValue(100));
  expect(result.current.get()).toBe(0);
  act(() => nextScroll.setValue(50));
  expect(result.current.get()).toBe(50);
  unmount();
  expect(removeNext).toHaveBeenCalledTimes(1);
  notify.mockClear();
  act(() => nextScroll.setValue(150));
  expect(notify).not.toHaveBeenCalled();
});
