import { fireEvent, render, screen } from '@testing-library/react-native';

import { AgencyLogo, hasAgencyLogo } from '../src/components/AgencyLogo';
import { LineLayersSheet } from '../src/components/LineLayersSheet';
import { EMPTY_LINE_LAYERS } from '../src/data/lineLayers';
import { AppSettingsProvider } from '../src/theme/AppSettings';

describe('AgencyLogo', () => {
  it('gives Metro-North its own logo, like the LIRR', () => {
    expect(hasAgencyLogo('metronorth')).toBe(true);
    expect(hasAgencyLogo('lirr')).toBe(true);
    // The Manhattan bus id `mn` stays the MTA mark, not Metro-North.
    render(<AppSettingsProvider><AgencyLogo agencyId="metronorth" testID="mnr-logo" /><AgencyLogo agencyId="mn" testID="mn-logo" /></AppSettingsProvider>);
    expect(screen.getByTestId('mnr-logo').props.accessibilityLabel).toBe('Metro-North Railroad');
    expect(screen.getByTestId('mn-logo').props.accessibilityLabel).toBe('MTA');
  });

  it('draws nothing for an agency without a logo', () => {
    expect(hasAgencyLogo('siferry')).toBe(false);
  });
});

describe('LineLayersSheet', () => {
  it('offers Metro-North as its own agency switch, next to the LIRR', () => {
    const onChange = jest.fn();
    render(<AppSettingsProvider><LineLayersSheet choice={EMPTY_LINE_LAYERS} lines={[]} onChange={onChange} onClose={() => {}} visible={true} /></AppSettingsProvider>);
    expect(screen.getByText('Metro-North')).toBeTruthy();
    expect(screen.getByTestId('line-layer-group-lirr')).toBeTruthy();
    fireEvent(screen.getByTestId('line-layer-group-metronorth'), 'valueChange', true);
    expect(onChange).toHaveBeenCalledWith({ groups: ['metronorth'], routes: [] });
  });
});
