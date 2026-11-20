import { fireEvent, render, screen } from '@testing-library/react-native';
import { SvgXml } from 'react-native-svg';

import { AgencyLogo, hasAgencyLogo } from '../src/components/AgencyLogo';
import { LineLayersSheet } from '../src/components/LineLayersSheet';
import { TransitCard } from '../src/components/TransitCard';
import { routeById, type RouteDetail } from '../src/data/transit';
import { badgeLabel, RouteBadge, transitModeForAgency } from '../src/components/RouteBadge';
import { searchLineIndex, type IndexedLine } from '../src/data/lineIndex';
import { EMPTY_LINE_LAYERS, LINE_LAYER_GROUPS } from '../src/data/lineLayers';
import { MAP_EXPLORATION_BOUNDS, SERVICE_AREA_BOUNDS } from '../src/data/serviceArea';
import { stopKindLabel } from '../src/data/stopSearch';
import { pathLineCode } from '../src/data/pathLines';
import { lineBadge, type TransitStep } from '../src/data/tripPlanning';
import { AppSettingsProvider } from '../src/theme/AppSettings';

const line = (agencyId: IndexedLine['agencyId'], agencyDisplayName: string, shortName: string, routeName: string, routeId = shortName): IndexedLine => ({
  agencyId, agencyDisplayName, routeId, shortName, routeName, color: '#000000',
});

const index: IndexedLine[] = [
  line('subway', 'MTA Subway', '1', 'Broadway - 7 Avenue Local'),
  line('lirr', 'LIRR', 'Port Jefferson', 'Port Jefferson Branch', '1'),
  line('nice', 'NICE Bus', 'n4', 'Freeport - Jamaica'),
  line('path', 'PATH', 'HOB-33', 'Hoboken - 33rd Street', '859'),
  line('path', 'PATH', 'NWK-WTC', 'Newark - World Trade Center', '862'),
  line('path', 'PATH', 'JSQ-HOB-33', 'Journal Square - 33rd Street (via Hoboken)', '1024'),
];

const names = (query: string) => searchLineIndex(index, query).map((found) => `${found.agencyId}:${found.routeId}`);

describe('PATH lines in search on the device', () => {
  it('narrows to PATH by its name, and counts it as a train', () => {
    expect(names('path')).toEqual(['path:859', 'path:862', 'path:1024']);
    expect(names('path train')).toHaveLength(3);
    expect(names('nwk-wtc')).toEqual(['path:862']);
    expect(names('JSQ HOB 33')[0]).toBe('path:1024');
    expect(names('train')).toEqual(expect.arrayContaining(['path:859', 'subway:1', 'lirr:1']));
    expect(names('commuter rail')).not.toContain('path:859');
  });
});

describe('PATH badges, logo and labels', () => {
  it('rides like the subway', () => {
    expect(transitModeForAgency('PATH')).toBe('subway');
    expect(stopKindLabel('subway', 'PATH')).toBe('PATH station');
  });

  it('carries the logo of the Port Authority, which runs it', () => {
    expect(hasAgencyLogo('path')).toBe(true);
    render(<AppSettingsProvider><AgencyLogo agencyId="path" testID="path-logo" /></AppSettingsProvider>);
    expect(screen.getByTestId('path-logo').props.accessibilityLabel).toBe('Port Authority of New York and New Jersey');
  });

  it('names its lines by code, as the backend does', () => {
    expect(pathLineCode('Newark - World Trade Center')).toBe('NWK-WTC');
    expect(pathLineCode('Journal Square - 33rd Street (via Hoboken)')).toBe('JSQ-HOB-33');
    expect(badgeLabel({ agency: 'PATH', shortName: 'JSQ-HOB-33' })).toBe('JSQ-HOB-33');
  });

  it('badges a planned PATH leg with its line code', () => {
    const step = (agency: string, name: string, shortName?: string) => ({ kind: 'transit', mode: 'subway', agency: { name: agency }, line: { name, ...(shortName ? { shortName } : {}) } }) as unknown as TransitStep;
    expect(lineBadge(step('PATH', 'Newark - World Trade Center', 'NWK-WTC'))).toBe('NWK-WTC');
    expect(lineBadge(step('Port Authority Trans-Hudson', 'Hoboken - 33rd Street'))).toBe('HOB-33');
    expect(lineBadge(step('PATH', 'PATH'))).toBe('PATH');
  });

  it('signs each line with the PATH P in its own color, its code read aloud', () => {
    render(<AppSettingsProvider><RouteBadge agency="PATH" color="#D93A30" shortName="NWK-WTC" testID="nwk" /><RouteBadge agency="Port Authority Trans-Hudson" color="#65C100" shortName="HOB-WTC" testID="hob" /></AppSettingsProvider>);
    expect(screen.getByTestId('nwk').props.accessibilityLabel).toBe('NWK-WTC PATH train');
    expect(screen.queryByText('NWK-WTC')).toBeNull();
    const [nwk, hob] = screen.UNSAFE_getAllByType(SvgXml).map((mark) => String(mark.props.xml));
    expect(nwk).toContain('#D93A30');
    expect(hob).toContain('#65C100');
    expect(nwk).not.toContain('#0095D3');
  });

  it('gives a line that joins two others a second color, so lines sharing a feed color differ', () => {
    render(<AppSettingsProvider><RouteBadge agency="PATH" color="#FF9900" shortName="JSQ-33" testID="jsq" /><RouteBadge agency="PATH" color="#FF9900" shortName="JSQ-HOB-33" testID="via" /></AppSettingsProvider>);
    const [jsq, via] = screen.UNSAFE_getAllByType(SvgXml).map((mark) => String(mark.props.xml));
    expect(jsq).not.toContain('#4D92FB');
    expect(via).toContain('#FF9900');
    expect(via).toContain('#4D92FB');
  });
});

describe('PATH on the home cards', () => {
  it('shows the P in white in place of the line name', () => {
    const route: RouteDetail = { ...routeById.ronkonkoma, id: 'path-862', agency: 'PATH', shortName: 'NWK-WTC', routeName: 'Newark - World Trade Center', color: '#D93A30' };
    render(<AppSettingsProvider><TransitCard onPress={() => undefined} route={route} /></AppSettingsProvider>);
    expect(screen.queryByText('NWK-WTC')).toBeNull();
    expect(screen.queryByText('PATH')).toBeNull();
    const marks = screen.UNSAFE_getAllByType(SvgXml).map((mark) => String(mark.props.xml));
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) expect(mark).toContain('#FFFFFF');
  });
});

describe('PATH on the map', () => {
  it('is its own switch in the layers sheet, with no NJ Transit groups', () => {
    const onChange = jest.fn();
    render(<AppSettingsProvider><LineLayersSheet choice={EMPTY_LINE_LAYERS} lines={[]} onChange={onChange} onClose={() => {}} visible={true} /></AppSettingsProvider>);
    expect(screen.getByText('PATH')).toBeTruthy();
    expect(screen.queryByText(/NJ Transit/)).toBeNull();
    fireEvent(screen.getByTestId('line-layer-group-path'), 'valueChange', true);
    expect(onChange).toHaveBeenCalledWith({ groups: ['path'], routes: [] });
    expect(LINE_LAYER_GROUPS.some((group) => (group.id as string).startsWith('njt'))).toBe(false);
  });

  it('covers New Jersey in the service area, with room to browse past it', () => {
    const inArea = (lat: number, lng: number) => lat >= SERVICE_AREA_BOUNDS.south && lat <= SERVICE_AREA_BOUNDS.north && lng >= SERVICE_AREA_BOUNDS.west && lng <= SERVICE_AREA_BOUNDS.east;
    expect(inArea(40.7359, -74.0292)).toBe(true); // Hoboken
    expect(inArea(40.7347, -74.1644)).toBe(true); // Newark Penn
    expect(MAP_EXPLORATION_BOUNDS.south).toBeLessThan(SERVICE_AREA_BOUNDS.south);
    expect(MAP_EXPLORATION_BOUNDS.west).toBeLessThan(SERVICE_AREA_BOUNDS.west);
  });
});
