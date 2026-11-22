import { act, fireEvent, render } from '@testing-library/react-native';

import { SavePlaceSheet } from '../src/components/SavePlaceSheet';
import { RouteAlertsPrompt } from '../src/components/RouteAlertsPrompt';
import { AppSettingsProvider } from '../src/theme/AppSettings';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const request = { place: { id: 'gym', title: 'Gym address', subtitle: '1 Main St', location: { latitude: 40.7, longitude: -73.9 } }, editing: true };

it('keeps favorite input on rejected save and prevents save/remove duplication while pending', async () => {
  const pending = deferred();
  const onSave = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
  const onRemove = jest.fn();
  const screen = render(<AppSettingsProvider><SavePlaceSheet onCancel={jest.fn()} onSave={onSave} onRemove={onRemove} request={request} /></AppSettingsProvider>);
  fireEvent.changeText(screen.getByTestId('save-place-name'), 'Gym near work');
  fireEvent.press(screen.getByTestId('save-place-icon-heart'));
  fireEvent.press(screen.getByTestId('save-place-confirm'));
  fireEvent.press(screen.getByTestId('save-place-confirm'));
  fireEvent.press(screen.getByTestId('save-place-remove'));
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onRemove).not.toHaveBeenCalled();
  expect(screen.getByTestId('save-place-confirm').props.accessibilityState).toMatchObject({ busy: true, disabled: true });
  await act(async () => { pending.reject(new Error('offline')); });
  expect(screen.getByTestId('save-place-name').props.value).toBe('Gym near work');
  expect(screen.getByTestId('save-place-icon-heart').props.accessibilityState.selected).toBe(true);
  expect(screen.getByText(/Favorite could not be saved/)).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId('save-place-confirm')); });
  expect(onSave).toHaveBeenLastCalledWith('Gym near work', { icon: 'heart', color: undefined, group: undefined });
  expect(onSave).toHaveBeenCalledTimes(2);
});

it('keeps the favorite editor open when removal fails', async () => {
  const onRemove = jest.fn().mockRejectedValue(new Error('denied'));
  const onCancel = jest.fn();
  const screen = render(<AppSettingsProvider><SavePlaceSheet onCancel={onCancel} onSave={jest.fn()} onRemove={onRemove} request={request} /></AppSettingsProvider>);
  fireEvent.changeText(screen.getByTestId('save-place-name'), 'My gym');
  await act(async () => { fireEvent.press(screen.getByTestId('save-place-remove')); });
  expect(screen.getByTestId('save-place-name').props.value).toBe('My gym');
  expect(screen.getByText(/Favorite could not be removed/)).toBeTruthy();
  expect(onCancel).not.toHaveBeenCalled();
});

it('preserves custom alert hours on failure and blocks duplicate Done writes', async () => {
  const pending = deferred();
  const onDone = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
  const onClose = jest.fn();
  const screen = render(<AppSettingsProvider><RouteAlertsPrompt onClose={onClose} onDone={onDone} request={{ id: 'suffolk:51', setting: 'custom' }} /></AppSettingsProvider>);
  fireEvent.changeText(screen.getByTestId('route-alerts-start'), '8:45 PM');
  fireEvent.changeText(screen.getByTestId('route-alerts-end'), '6:10 AM');
  fireEvent.press(screen.getByTestId('route-alerts-prompt-done'));
  fireEvent.press(screen.getByTestId('route-alerts-prompt-done'));
  expect(onDone).toHaveBeenCalledTimes(1);
  await act(async () => { pending.reject(new Error('offline')); });
  expect(screen.getByTestId('route-alerts-start').props.value).toBe('8:45 PM');
  expect(screen.getByTestId('route-alerts-end').props.value).toBe('6:10 AM');
  expect(screen.getByText(/Alert preference could not be saved/)).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByTestId('route-alerts-prompt-done')); });
  expect(onDone).toHaveBeenLastCalledWith('custom', { start: 1245, end: 370 });
});
