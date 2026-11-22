// Types only (erased from the bundle): the style spec both map libraries render.
import type { ExpressionSpecification, LayerSpecification, StyleSpecification, SymbolLayerSpecification } from '@maplibre/maplibre-gl-style-spec';

import { MAP_EXPLORATION_BOUNDS } from '../data/serviceArea';
import type { MapTheme, TransitIcons } from '../theme/AppSettings';

/**
 * The base map every Pathly map draws (home, route, trip, and choose-on-map; native and web):
 * Pathly's own vector tiles of New York City, Long Island, and the region around them, built from
 * public-domain government data (Census TIGER/Line streets, water, parks, and places; USGS names;
 * NYC building footprints) and OpenStreetMap's footpaths, by scripts/build-map.mjs, and labeled in Nunito, the app's typeface
 * (scripts/build-map-fonts.mjs). Styled to read like the familiar maps riders know (white streets
 * with gray edges, blue water, green parks) with Pathly's own changes: highways in quiet gray so
 * route lines stand out, no business labels (stations keep theirs), and a dark version.
 *
 * The tiles and fonts are served from Pathly's site. EXPO_PUBLIC_MAP_TILES_URL and
 * EXPO_PUBLIC_MAP_GLYPHS_URL point the map elsewhere (a local copy while building the map, say).
 */

const SITE = 'https://pathly.web.app/map';

/** The credit the map shows (OpenStreetMap's footpaths and Microsoft's buildings need it; the government data doesn't). */
export const MAP_ATTRIBUTION = '© OpenStreetMap contributors, Microsoft';
export const MAP_TILES_URL = process.env.EXPO_PUBLIC_MAP_TILES_URL || `${SITE}/tiles/{z}/{x}/{y}.pbf`;
const MAP_GLYPHS_URL = process.env.EXPO_PUBLIC_MAP_GLYPHS_URL || `${SITE}/fonts/{fontstack}/{range}.pbf`;

/** Where the tiles reach (the build's overview area: the exploration box and the region around it). */
const TILE_BOUNDS: [number, number, number, number] = [
  MAP_EXPLORATION_BOUNDS.west - 5,
  MAP_EXPLORATION_BOUNDS.south - 4,
  MAP_EXPLORATION_BOUNDS.east + 5,
  MAP_EXPLORATION_BOUNDS.north + 4,
];
const TILES_MAX_ZOOM = 14;

/**
 * Empty layers at the top of the style that Pathly's own lines and dots are slotted beneath
 * (map/MapCanvas: a layer with zIndex z goes just under slot z + 1), so they always draw above the
 * base map and in a fixed order among themselves, whenever each is added.
 */
export const OVERLAY_SLOTS = 8;
export const overlaySlotId = (slot: number) => `pathly-slot-${Math.max(0, Math.min(OVERLAY_SLOTS, slot))}`;

const SOURCE = 'pathly';
const REGULAR = ['Nunito-Regular'];
const SEMIBOLD = ['Nunito-SemiBold'];
const BOLD = ['Nunito-Bold'];
const ITALIC = ['Nunito-Italic'];

export type MapPalette = {
  land: string;
  manMade: string;
  park: string;
  grass: string;
  hospital: string;
  school: string;
  water: string;
  aeroArea: string;
  building: string;
  buildingOutline: string;
  casing: string;
  minor: string;
  arterial: string;
  arterialCasing: string;
  highway: string;
  highwayCasing: string;
  motorway: string;
  motorwayCasing: string;
  path: string;
  rail: string;
  ferry: string;
  boundary: string;
  label: string;
  labelHalo: string;
  placeLabel: string;
  neighborhoodLabel: string;
  roadLabel: string;
  waterLabel: string;
  parkLabel: string;
  stationLabel: string;
};

/** Light: the familiar map's colors, highways grayed (they competed with route lines). */
const LIGHT: MapPalette = {
  land: '#F2F1EB',
  manMade: '#EAE8E2',
  park: '#B5E0A8',
  grass: '#CDEBBF',
  hospital: '#F9D9D5',
  school: '#E8E9EA',
  water: '#90C4F3',
  aeroArea: '#E2E5EB',
  building: '#E3E0D9',
  buildingOutline: '#CDC9C1',
  casing: '#C3C7CD',
  minor: '#FFFFFF',
  arterial: '#FFFFFF',
  arterialCasing: '#B3B8BF',
  highway: '#DADCE0',
  highwayCasing: '#A9AEB6',
  motorway: '#DADCE0',
  motorwayCasing: '#A2A7AF',
  path: '#9FD6C1',
  rail: '#A9AEB5',
  ferry: '#4F8FD6',
  boundary: '#A4A9B0',
  label: '#5F6368',
  labelHalo: '#FFFFFF',
  placeLabel: '#3C4043',
  neighborhoodLabel: '#7A7F86',
  roadLabel: '#5F6368',
  waterLabel: '#2F6AB0',
  parkLabel: '#2E7A40',
  stationLabel: '#3C4F66',
};

/** Dark: black and dark-gray surfaces, light-gray labels; water and parks just distinguishable. */
const DARK: MapPalette = {
  land: '#16171A',
  manMade: '#1B1C1F',
  park: '#172A1D',
  grass: '#17261B',
  hospital: '#1E1B1D',
  school: '#1C1C1F',
  water: '#0B1A2E',
  aeroArea: '#1B1C1F',
  building: '#1E1F23',
  buildingOutline: '#25272C',
  casing: '#0F1012',
  minor: '#2A2D33',
  arterial: '#32353C',
  arterialCasing: '#0F1012',
  highway: '#3C4048',
  highwayCasing: '#0F1012',
  motorway: '#454A53',
  motorwayCasing: '#0F1012',
  path: '#2D4D44',
  rail: '#2A2D33',
  ferry: '#2B5888',
  boundary: '#3A3D42',
  label: '#8E949C',
  labelHalo: '#16171A',
  placeLabel: '#B3B9C1',
  neighborhoodLabel: '#80868E',
  roadLabel: '#9AA0A8',
  waterLabel: '#5279A6',
  parkLabel: '#629C6E',
  stationLabel: '#B3B9C1',
};

/** Muted: grays with only a hint of green and blue, so route lines stand out the most. */
const MUTED_LIGHT: MapPalette = {
  ...LIGHT,
  land: '#F3F3F2', manMade: '#ECECEB', park: '#DCE6DA', grass: '#E3EBE1', hospital: '#EFE6E5', school: '#EDEBE6',
  water: '#C9D6E0', aeroArea: '#E8E9EB', building: '#E4E4E3', buildingOutline: '#D2D2D1',
  casing: '#D0D0D0', arterialCasing: '#C4C4C4', highway: '#E0E0E0', highwayCasing: '#BDBDBD', motorway: '#DCDCDC', motorwayCasing: '#B8B8B8',
  path: '#B9CEC6', rail: '#BDBDBD', ferry: '#8FA6BA', boundary: '#B5B5B5',
  label: '#707070', placeLabel: '#4A4A4A', neighborhoodLabel: '#8A8A8A', roadLabel: '#707070', waterLabel: '#5F7A90', parkLabel: '#5E7A5E',
  stationLabel: '#4A5560',
};
const MUTED_DARK: MapPalette = {
  ...DARK,
  land: '#18181A', manMade: '#1C1C1E', park: '#1C221D', grass: '#1B201C', hospital: '#1E1C1D', school: '#1C1C1E',
  water: '#14191F', aeroArea: '#1D1D20', building: '#202022', buildingOutline: '#28282B',
  casing: '#0F0F10', minor: '#2A2A2D', arterial: '#313134', arterialCasing: '#0F0F10', highway: '#38383C', highwayCasing: '#0F0F10', motorway: '#3E3E42', motorwayCasing: '#0F0F10',
  path: '#38433F', rail: '#2B2B2E', ferry: '#36506A', boundary: '#3A3A3D',
  label: '#87898D', labelHalo: '#18181A', placeLabel: '#ABADB1', neighborhoodLabel: '#7B7D81', roadLabel: '#929498', waterLabel: '#5D7288', parkLabel: '#6E8570',
  stationLabel: '#ABADB1',
};

/** Vibrant: deeper blues and greens, and highways in a soft yellow. */
const VIBRANT_LIGHT: MapPalette = {
  ...LIGHT,
  land: '#F6F5EE', park: '#8FD68A', grass: '#B4E6A6', hospital: '#FBC9C2', school: '#F5E2B8',
  water: '#5DB0F5', aeroArea: '#DCE2EE', building: '#E0DCD2', buildingOutline: '#C6C0B4',
  arterialCasing: '#A7AEB8', highway: '#FCE9B6', highwayCasing: '#E3C27A', motorway: '#FBDFA0', motorwayCasing: '#DDB36A',
  path: '#86CFB3', ferry: '#1E7FE0', waterLabel: '#1A5FB4', parkLabel: '#1F7A32',
};
const VIBRANT_DARK: MapPalette = {
  ...DARK,
  land: '#121418', park: '#143A22', grass: '#163220', hospital: '#2A1A1C', school: '#262218',
  water: '#0A2747', minor: '#2A2E35', arterial: '#343841', highway: '#4A4636', motorway: '#57503A',
  path: '#2B5A4B', ferry: '#2E73C0', labelHalo: '#121418', waterLabel: '#5C93D6', parkLabel: '#5FB872',
};

/** Warm: paper-cream land and soft, earthy greens and blues. */
const WARM_LIGHT: MapPalette = {
  land: '#F5EFE3', manMade: '#EDE5D6', park: '#CFE0B0', grass: '#DCE8C2', hospital: '#F4D9CF', school: '#EFE3CC',
  water: '#A9CDE0', aeroArea: '#E6E1D6', building: '#E7DECF', buildingOutline: '#D3C7B4',
  casing: '#D4C9B6', minor: '#FFFDF8', arterial: '#FFFBF2', arterialCasing: '#C9BBA4', highway: '#EBDDC4', highwayCasing: '#C4AE8A', motorway: '#E8D6B6', motorwayCasing: '#BFA37A',
  path: '#B3C69E', rail: '#B8AA94', ferry: '#5E8FB5', boundary: '#B8A991',
  label: '#6B5E4E', labelHalo: '#FFFBF2', placeLabel: '#4A3F33', neighborhoodLabel: '#8A7C6A', roadLabel: '#6B5E4E', waterLabel: '#3E6F8F', parkLabel: '#4E7A3A',
  stationLabel: '#4D4438',
};
const WARM_DARK: MapPalette = {
  land: '#1C1915', manMade: '#201C18', park: '#1F2619', grass: '#1E2318', hospital: '#241C1A', school: '#221E18',
  water: '#12202A', aeroArea: '#211D19', building: '#24201B', buildingOutline: '#2C2721',
  casing: '#110F0D', minor: '#2F2A24', arterial: '#37312A', arterialCasing: '#110F0D', highway: '#423A30', highwayCasing: '#110F0D', motorway: '#4B4236', motorwayCasing: '#110F0D',
  path: '#3A4230', rail: '#2F2A24', ferry: '#3B6280', boundary: '#3E3830',
  label: '#9A8F80', labelHalo: '#1C1915', placeLabel: '#C2B6A5', neighborhoodLabel: '#8A7F70', roadLabel: '#A59A8B', waterLabel: '#5E86A3', parkLabel: '#7A9A62',
  stationLabel: '#C2B6A5',
};

const PALETTES: Record<MapTheme, { light: MapPalette; dark: MapPalette }> = {
  default: { light: LIGHT, dark: DARK },
  muted: { light: MUTED_LIGHT, dark: MUTED_DARK },
  vibrant: { light: VIBRANT_LIGHT, dark: VIBRANT_DARK },
  warm: { light: WARM_LIGHT, dark: WARM_DARK },
};

/** A map theme's colors in the light or dark version (also drawn as the theme's preview in Settings). */
export function mapPalette(isDark: boolean, theme: MapTheme = 'default'): MapPalette {
  const entry = PALETTES[theme] ?? PALETTES.default;
  return isDark ? entry.dark : entry.light;
}

/** A line width growing with zoom (each step up doubles the scale, so widths grow ~1.5x per zoom). */
function width(...stops: number[]): ExpressionSpecification {
  return ['interpolate', ['exponential', 1.5], ['zoom'], ...stops] as ExpressionSpecification;
}

/** The same widths, with ramps (link) narrower than the highway they join. */
function widthWithLinks(...stops: number[]): ExpressionSpecification {
  const out: unknown[] = ['interpolate', ['exponential', 1.5], ['zoom']];
  for (let i = 0; i < stops.length; i += 2) out.push(stops[i], ['case', ['==', ['get', 'link'], 1], stops[i + 1]! * 0.55, stops[i + 1]]);
  return out as ExpressionSpecification;
}

/** Areas ease in over half a zoom from where they start, rather than popping in or out. */
/** Short dead-end footpaths show from this zoom (MapLibre's): zoomed in close, at street level. */
const STUB_ZOOM = 16.5;

const fadeIn = (zoom: number): ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], zoom, 0, zoom + 0.5, 1];

const NAME: ExpressionSpecification = ['get', 'name'];
const POINTS: ExpressionSpecification = ['==', ['geometry-type'], 'Point'];
const AREAS: ExpressionSpecification = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];

type RoadKind = { id: string; kinds: string[]; fill: keyof MapPalette; casing: keyof MapPalette; minzoom: number; fillWidth: ExpressionSpecification; casingWidth: ExpressionSpecification };

/** Street kinds, least important first so the bigger roads draw over them. */
const ROADS: RoadKind[] = [
  { id: 'path', kinds: ['path'], fill: 'path', casing: 'path', minzoom: 13, fillWidth: width(13, 0.5, 15, 0.9, 16, 1.2, 18, 2.5), casingWidth: width(13, 0, 18, 0) },
  { id: 'service', kinds: ['service'], fill: 'minor', casing: 'casing', minzoom: 14, fillWidth: width(14, 0.6, 16, 3, 18, 8), casingWidth: width(14, 1.2, 16, 4.5, 18, 10) },
  { id: 'minor', kinds: ['minor'], fill: 'minor', casing: 'casing', minzoom: 11, fillWidth: width(11, 0.5, 12, 0.9, 13, 1.6, 14, 2.6, 16, 6, 18, 16), casingWidth: width(11, 0.5, 12, 1.9, 13, 2.8, 14, 3.6, 16, 7.5, 18, 18.5) },
  { id: 'tertiary', kinds: ['tertiary'], fill: 'arterial', casing: 'arterialCasing', minzoom: 9, fillWidth: width(9, 0.6, 10, 0.9, 12, 1.9, 14, 3.8, 16, 8, 18, 20), casingWidth: width(9, 0.6, 10, 0.9, 11, 1.9, 12, 3, 14, 5, 16, 10, 18, 23) },
  { id: 'secondary', kinds: ['secondary'], fill: 'arterial', casing: 'arterialCasing', minzoom: 8, fillWidth: width(8, 0.6, 12, 2.1, 14, 4.5, 16, 10, 18, 24), casingWidth: width(8, 0.9, 12, 2.8, 14, 6, 16, 12, 18, 27) },
  { id: 'primary', kinds: ['primary'], fill: 'arterial', casing: 'arterialCasing', minzoom: 7, fillWidth: width(6, 0.6, 10, 1.5, 12, 2.6, 14, 5.5, 16, 12, 18, 28), casingWidth: width(6, 0.9, 10, 2, 12, 3.6, 14, 7.2, 16, 14, 18, 31) },
  { id: 'motorway', kinds: ['motorway'], fill: 'motorway', casing: 'motorwayCasing', minzoom: 4, fillWidth: widthWithLinks(4, 0.5, 10, 1.8, 12, 3.2, 14, 6.5, 16, 14, 18, 32), casingWidth: widthWithLinks(4, 0.8, 10, 2.6, 12, 4.4, 14, 8.4, 16, 16, 18, 35) },
];

/**
 * Like Google's, streets have no edges far out: every road is one plain line (white in the light
 * themes, on light gray land), and the edges ease in from here over a zoom, as town streets come
 * into view, so a suburb's streets stand out from the land around them.
 */
const EDGE_ZOOM = 11;

/** Highways keep their edges at every zoom, so they still read as the biggest roads. */
const ALWAYS_EDGED = new Set(['motorway']);

function roadLayers(palette: MapPalette, brunnel: 'tunnel' | 'road' | 'bridge'): LayerSpecification[] {
  const brunnelFilter: ExpressionSpecification = brunnel === 'road'
    ? ['!', ['match', ['get', 'brunnel'], ['tunnel', 'bridge'], true, false]]
    : ['==', ['get', 'brunnel'], brunnel];
  const opacity = brunnel === 'tunnel' ? 0.5 : 1;
  const edgeOpacity = (road: RoadKind): ExpressionSpecification | number =>
    ALWAYS_EDGED.has(road.id) ? opacity : ['interpolate', ['linear'], ['zoom'], EDGE_ZOOM, 0, EDGE_ZOOM + 1, opacity];
  const casings = ROADS.filter((road) => road.id !== 'path').map((road): LayerSpecification => ({
    id: `road-${brunnel}-${road.id}-casing`,
    type: 'line',
    source: SOURCE,
    'source-layer': 'road',
    minzoom: road.minzoom,
    filter: ['all', brunnelFilter, ['match', ['get', 'kind'], road.kinds, true, false]],
    layout: { 'line-cap': brunnel === 'tunnel' ? 'butt' : 'round', 'line-join': 'round' },
    paint: { 'line-color': palette[road.casing], 'line-width': road.casingWidth, 'line-opacity': edgeOpacity(road), ...(brunnel === 'tunnel' ? { 'line-dasharray': [1, 0.5] } : {}) },
  }));
  const fills = ROADS.map((road): LayerSpecification[] => {
    const filter: ExpressionSpecification = ['all', brunnelFilter, ['match', ['get', 'kind'], road.kinds, true, false]];
    const layer = {
      id: `road-${brunnel}-${road.id}`,
      type: 'line',
      source: SOURCE,
      'source-layer': 'road',
      minzoom: road.minzoom,
      filter,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette[road.fill],
        'line-width': road.fillWidth,
        // Footpaths (campus walks, park trails, steps): thin and tinted like Google's, easing in rather than popping in.
        'line-opacity': road.id === 'path' ? ['interpolate', ['linear'], ['zoom'], 13, 0, 13.5, opacity] : opacity,
      },
    } satisfies LayerSpecification;
    if (road.id !== 'path') return [layer];
    // Walkways solid; informal and unpaved paths (worn shortcuts, dirt trails) dashed. Short dead
    // ends (to a door, a bench, a platform) only once zoomed in close, so the map stays clean further out.
    return [false, true].flatMap((stub): LayerSpecification[] => {
      const stubFilter: ExpressionSpecification = stub ? ['has', 'stub'] : ['!', ['has', 'stub']];
      const close = stub
        ? { id: `${layer.id}-stub`, minzoom: STUB_ZOOM, paint: { ...layer.paint, 'line-opacity': ['interpolate', ['linear'], ['zoom'], STUB_ZOOM, 0, STUB_ZOOM + 0.5, opacity] as ExpressionSpecification } }
        : {};
      const solid = { ...layer, ...close, filter: ['all', filter, stubFilter, ['!', ['has', 'trail']]] } as LayerSpecification;
      const dashed = {
        ...layer,
        ...close,
        id: `${'id' in close ? close.id : layer.id}-trail`,
        filter: ['all', filter, stubFilter, ['has', 'trail']],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: { ...('paint' in close ? close.paint : layer.paint), 'line-dasharray': [3, 2.5] },
      } as LayerSpecification;
      return [solid, dashed];
    });
  });
  // A bridge draws its own edges and roadway over whatever passes beneath it.
  return brunnel === 'bridge' ? ROADS.flatMap((_, index) => [casings[index - 1], ...fills[index]!].filter((layer): layer is LayerSpecification => layer !== undefined)) : [...casings, ...fills.flat()];
}

/**
 * A label layer, plus copies for labels too small to show by the tiles' last zoom: those carry the
 * zoom they show from (`lz`, 15 or 16), and their copy waits until then.
 */
function withLateLabels(layer: SymbolLayerSpecification & { filter: ExpressionSpecification }): LayerSpecification[] {
  return [
    { ...layer, filter: ['all', layer.filter, ['!', ['has', 'lz']]] },
    ...[15, 16].map((zoom): LayerSpecification => ({ ...layer, id: `${layer.id}-${zoom}`, minzoom: zoom, filter: ['all', layer.filter, ['==', ['get', 'lz'], zoom]] })),
  ];
}

/**
 * The map's transit icons (the app's own mode icons, in gray: scripts/build-map-icons.mjs), by the
 * name each map kit registers them under (MapCanvas), one set per theme.
 */
/** The base map's layers of tappable transit icons (MapCanvas's onStopPress), bus stops first. */
export const STOP_LAYER_IDS = ['station-bus-icon', 'station-icon'];

/** The transit icon layers each Transit icons setting hides (Settings > Appearance). */
const HIDDEN_STOP_LAYERS: Record<TransitIcons, readonly string[]> = { all: [], stations: ['station-bus-icon'], none: STOP_LAYER_IDS };

export const TRANSIT_ICON_NAMES = ['transit-subway', 'transit-rail', 'transit-ferry', 'transit-bus'] as const;
export const transitIconName = (name: (typeof TRANSIT_ICON_NAMES)[number], isDark: boolean) => (isDark ? `${name}-dark` : name);

/**
 * Stations (subway, rail, ferry) as their mode's icon from as far out as a town's streets show,
 * named a zoom later; bus stops as a smaller bus icon at street level, with no name. Icons always
 * show (they don't hide each other), and a station's name gives way to other labels.
 */
function transitLayers(palette: MapPalette, isDark: boolean, halo: Record<string, unknown>): LayerSpecification[] {
  const icon = (name: (typeof TRANSIT_ICON_NAMES)[number]) => transitIconName(name, isDark);
  const isBus: ExpressionSpecification = ['==', ['get', 'kind'], 'bus'];
  const always = { 'icon-allow-overlap': true, 'icon-ignore-placement': true } as const;
  return [
    {
      id: 'station-bus-icon',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'poi',
      minzoom: 14,
      filter: isBus,
      layout: { 'icon-image': icon('transit-bus'), 'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.8, 16, 1, 18, 1.2], ...always },
    },
    {
      id: 'station-icon',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'poi',
      minzoom: 12,
      filter: ['!', isBus],
      layout: {
        'icon-image': ['match', ['get', 'kind'], 'rail', icon('transit-rail'), 'ferry', icon('transit-ferry'), icon('transit-subway')],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.75, 14, 0.9, 17, 1.1],
        ...always,
        // Names from a zoom later, under the icon.
        'text-field': ['step', ['zoom'], '', 13, NAME],
        'text-font': BOLD,
        'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 17, 13],
        'text-anchor': 'top',
        'text-offset': [0, 0.9],
        'text-max-width': 8,
        'text-padding': 4,
        'text-optional': true,
        'symbol-sort-key': ['match', ['get', 'kind'], 'rail', 0, 'subway', 1, 2],
      },
      paint: { 'text-color': palette.stationLabel, ...halo },
    },
  ];
}

function baseLayers(palette: MapPalette, isDark: boolean): LayerSpecification[] {
  const halo = { 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.5 };
  return [
    { id: 'background', type: 'background', paint: { 'background-color': palette.land } },
    { id: 'sea', type: 'fill', source: SOURCE, 'source-layer': 'sea', paint: { 'fill-color': palette.water } },
    { id: 'land', type: 'fill', source: SOURCE, 'source-layer': 'land', paint: { 'fill-color': palette.land } },
    {
      id: 'landuse-man-made',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'landuse',
      filter: ['all', AREAS, ['match', ['get', 'kind'], ['commercial', 'industrial'], true, false]],
      paint: { 'fill-color': palette.manMade, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 12, 0.8] },
    },
    { id: 'landuse-airport', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 9, filter: ['all', AREAS, ['==', ['get', 'kind'], 'airport']], paint: { 'fill-color': palette.aeroArea, 'fill-opacity': fadeIn(9) } },
    { id: 'landuse-hospital', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 12, filter: ['all', AREAS, ['==', ['get', 'kind'], 'hospital']], paint: { 'fill-color': palette.hospital, 'fill-opacity': fadeIn(12) } },
    { id: 'landuse-school', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 11, filter: ['all', AREAS, ['match', ['get', 'kind'], ['school', 'university'], true, false]], paint: { 'fill-color': palette.school, 'fill-opacity': fadeIn(11) } },
    { id: 'landuse-cemetery', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 11, filter: ['all', AREAS, ['==', ['get', 'kind'], 'cemetery']], paint: { 'fill-color': palette.grass, 'fill-opacity': fadeIn(11) } },
    { id: 'landuse-recreation', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 12, filter: ['all', AREAS, ['match', ['get', 'kind'], ['theme_park', 'zoo'], true, false]], paint: { 'fill-color': palette.grass, 'fill-opacity': fadeIn(12) } },
    { id: 'park', type: 'fill', source: SOURCE, 'source-layer': 'park', filter: ['all', AREAS, ['==', ['get', 'kind'], 'park']], paint: { 'fill-color': palette.park } },
    // National parks (in the tiles from zoom 9, with the detailed water over their bays) ease in.
    { id: 'park-national', type: 'fill', source: SOURCE, 'source-layer': 'park', minzoom: 9, filter: ['all', AREAS, ['==', ['get', 'kind'], 'national_park']], paint: { 'fill-color': palette.park } },
    { id: 'park-golf', type: 'fill', source: SOURCE, 'source-layer': 'park', minzoom: 10, filter: ['all', AREAS, ['==', ['get', 'kind'], 'golf_course']], paint: { 'fill-color': palette.grass, 'fill-opacity': fadeIn(10) } },
    // Sports fields, courts, and stadiums, like a park (OpenStreetMap's; small courts show from closer in).
    { id: 'park-pitch', type: 'fill', source: SOURCE, 'source-layer': 'park', minzoom: 13, filter: ['all', AREAS, ['==', ['get', 'kind'], 'pitch']], paint: { 'fill-color': palette.park, 'fill-opacity': fadeIn(13) } },
    // The water over parks and the like, whose outlines often run out over a bay.
    { id: 'water', type: 'fill', source: SOURCE, 'source-layer': 'water', paint: { 'fill-color': palette.water } },
    {
      id: 'waterway',
      type: 'line',
      source: SOURCE,
      'source-layer': 'waterway',
      minzoom: 10,
      layout: { 'line-cap': 'round' },
      // Rivers and canals wider than streams; zoom must be the outermost curve.
      paint: {
        'line-color': palette.water,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, ['match', ['get', 'kind'], ['river', 'canal'], 0.8, 0], 12, ['match', ['get', 'kind'], ['river', 'canal'], 1.8, 0.4], 14, ['match', ['get', 'kind'], ['river', 'canal'], 3, 1], 18, ['match', ['get', 'kind'], ['river', 'canal'], 12, 4]],
      },
    },
    {
      id: 'building',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'building',
      minzoom: 14,
      paint: {
        'fill-color': palette.building,
        'fill-outline-color': palette.buildingOutline,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1],
      },
    },
    // Bus and train platforms (OpenStreetMap's), paved like Google's, over the terminal around them.
    {
      id: 'landuse-platform',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'landuse',
      minzoom: 14,
      filter: ['all', AREAS, ['==', ['get', 'kind'], 'platform']],
      paint: { 'fill-color': palette.school, 'fill-outline-color': palette.buildingOutline },
    },
    ...roadLayers(palette, 'tunnel'),
    ...roadLayers(palette, 'road'),
    {
      id: 'railway',
      type: 'line',
      source: SOURCE,
      'source-layer': 'rail',
      minzoom: 10,
      paint: { 'line-color': palette.rail, 'line-width': width(10, 0.6, 14, 1.4, 18, 3) },
    },
    {
      id: 'railway-hatching',
      type: 'line',
      source: SOURCE,
      'source-layer': 'rail',
      minzoom: 14,
      paint: { 'line-color': palette.rail, 'line-width': width(14, 3, 18, 8), 'line-dasharray': [0.2, 4] },
    },
    ...roadLayers(palette, 'bridge'),
    {
      // Which way a bus ramp or lane runs, in small arrows along it, close in.
      id: 'road-oneway-arrow',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'road',
      minzoom: 16,
      filter: ['has', 'oneway'],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 70,
        'icon-image': isDark ? 'oneway-arrow-dark' : 'oneway-arrow',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 16, 0.7, 18, 1],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
    {
      id: 'ferry',
      type: 'line',
      source: SOURCE,
      'source-layer': 'ferry',
      minzoom: 12,
      paint: { 'line-color': palette.ferry, 'line-width': width(12, 0.7, 16, 1.6), 'line-dasharray': [3, 2], 'line-opacity': 0.7 },
    },
    {
      id: 'boundary-state',
      type: 'line',
      source: SOURCE,
      'source-layer': 'boundary',
      paint: { 'line-color': palette.boundary, 'line-width': width(4, 0.6, 12, 1.6), 'line-dasharray': [3, 2] },
    },
    {
      id: 'waterway-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'waterway',
      minzoom: 13,
      filter: ['all', ['has', 'name'], ['match', ['get', 'kind'], ['river', 'canal'], true, false]],
      layout: { 'symbol-placement': 'line', 'text-field': NAME, 'text-font': ITALIC, 'text-size': 12, 'text-letter-spacing': 0.1 },
      paint: { 'text-color': palette.waterLabel, ...halo, 'text-halo-width': 1.2 },
    },
    ...withLateLabels({
      id: 'water-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'water_name',
      filter: POINTS,
      layout: {
        'text-field': NAME,
        'text-font': ITALIC,
        'text-size': ['interpolate', ['linear'], ['zoom'], 6, ['match', ['get', 'kind'], 'ocean', 13, 11], 14, ['match', ['get', 'kind'], ['ocean', 'bay'], 16, 13]],
        'text-max-width': 8,
        'text-letter-spacing': 0.05,
      },
      paint: { 'text-color': palette.waterLabel, ...halo, 'text-halo-width': 1.2 },
    }),
    ...withLateLabels({
      id: 'park-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'park',
      minzoom: 10,
      filter: POINTS,
      layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10.5, 16, 13], 'text-max-width': 7, 'text-padding': 4 },
      paint: { 'text-color': palette.parkLabel, ...halo },
    }),
    // Like Google's, a side street's name waits until it's close (a main road's shows sooner), and a
    // driveway's or parking aisle's later still.
    ...([
      ['road-label', 12, ['motorway', 'primary', 'secondary', 'tertiary']],
      ['road-label-minor', 13, ['minor']],
      ['road-label-service', 15.5, ['service']],
    ] as const).map(([id, minzoom, kinds]): LayerSpecification => ({
      id,
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'road',
      minzoom,
      filter: ['all', ['has', 'name'], ['match', ['get', 'kind'], [...kinds], true, false]],
      layout: {
        'symbol-placement': 'line',
        'text-field': NAME,
        'text-font': REGULAR,
        'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 12.5, 18, 14],
        'text-padding': 4,
        'symbol-spacing': 280,
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'viewport',
      },
      paint: { 'text-color': palette.roadLabel, ...halo },
    })),
    ...transitLayers(palette, isDark, halo),
    ...withLateLabels({
      // Platforms by name ("Ramp D", "Track 3"), close in.
      id: 'platform-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'landuse',
      minzoom: 15,
      filter: ['all', POINTS, ['==', ['get', 'kind'], 'platform']],
      layout: { 'text-field': NAME, 'text-font': SEMIBOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10, 18, 12.5], 'text-max-width': 8, 'text-padding': 2 },
      paint: { 'text-color': palette.label, ...halo },
    }),
    ...withLateLabels({
      // Campuses, hospitals, zoos, and cemeteries, named in their own colors like Google's.
      id: 'landmark-area-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'landuse',
      minzoom: 12,
      filter: ['all', POINTS, ['match', ['get', 'kind'], ['university', 'school', 'hospital', 'zoo', 'theme_park', 'cemetery'], true, false]],
      layout: { 'text-field': NAME, 'text-font': SEMIBOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10.5, 16, 12.5], 'text-max-width': 8, 'text-padding': 4, 'symbol-sort-key': ['get', 'rank'] },
      paint: {
        'text-color': ['match', ['get', 'kind'], 'hospital', isDark ? '#F28B82' : '#C5221F', ['zoo', 'theme_park', 'cemetery'], palette.parkLabel, palette.label],
        ...halo,
      },
    }),
    {
      // Stadiums, malls, museums, and sights (OpenStreetMap's notable ones; businesses stay hidden).
      id: 'landmark-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'landmark',
      minzoom: 13,
      layout: { 'text-field': NAME, 'text-font': SEMIBOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 16, 12.5], 'text-max-width': 8, 'text-padding': 6, 'symbol-sort-key': ['get', 'rank'] },
      paint: {
        'text-color': ['match', ['get', 'kind'],
          'mall', isDark ? '#8AB4F8' : '#3C6BC4',
          ['stadium', 'zoo', 'aquarium', 'theme_park'], isDark ? '#81C995' : '#1E7E45',
          isDark ? '#78D9EC' : '#0F7C8C'],
        ...halo,
      },
    },
    {
      id: 'airport-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'landuse',
      minzoom: 9,
      filter: ['all', POINTS, ['==', ['get', 'kind'], 'airport']],
      layout: { 'text-field': NAME, 'text-font': SEMIBOLD, 'text-size': 11, 'text-max-width': 8 },
      paint: { 'text-color': palette.label, ...halo },
    },
    ...withLateLabels({
      id: 'place-island',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 10,
      filter: ['==', ['get', 'kind'], 'island'],
      layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10.5, 16, 13], 'text-max-width': 7, 'text-padding': 6 },
      paint: { 'text-color': palette.neighborhoodLabel, ...halo },
    }),
    {
      id: 'place-neighborhood',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 11,
      maxzoom: 17,
      filter: ['==', ['get', 'kind'], 'neighbourhood'],
      layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 12.5], 'text-max-width': 7, 'text-padding': 6 },
      paint: { 'text-color': palette.neighborhoodLabel, ...halo },
    },
    {
      id: 'place-village',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 10,
      maxzoom: 16,
      filter: ['match', ['get', 'kind'], ['village', 'hamlet'], true, false],
      layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10.5, 15, 13.5], 'text-max-width': 7, 'text-padding': 8, 'symbol-sort-key': ['get', 'rank'] },
      paint: { 'text-color': palette.label, ...halo },
    },
    {
      id: 'place-borough',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 10,
      maxzoom: 15,
      filter: ['==', ['get', 'kind'], 'borough'],
      layout: { 'text-field': NAME, 'text-font': SEMIBOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 16], 'text-max-width': 8 },
      paint: { 'text-color': palette.neighborhoodLabel, ...halo },
    },
    {
      id: 'place-town',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 8,
      maxzoom: 15,
      filter: ['==', ['get', 'kind'], 'town'],
      layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 15], 'text-max-width': 8, 'symbol-sort-key': ['get', 'rank'] },
      paint: { 'text-color': palette.placeLabel, ...halo },
    },
    {
      id: 'place-city',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 4,
      maxzoom: 14,
      filter: ['==', ['get', 'kind'], 'city'],
      layout: { 'text-field': NAME, 'text-font': BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 10, 16, 13, 19], 'text-max-width': 8, 'symbol-sort-key': ['get', 'rank'] },
      paint: { 'text-color': palette.placeLabel, ...halo, 'text-halo-width': 1.8 },
    },
    {
      id: 'place-state',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 4,
      maxzoom: 9,
      filter: ['==', ['get', 'kind'], 'state'],
      layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 14], 'text-transform': 'uppercase', 'text-letter-spacing': 0.15, 'text-max-width': 8 },
      paint: { 'text-color': isDark ? '#6B7179' : '#9AA0A6', ...halo, 'text-halo-width': 1.2 },
    },
  ];
}

/** Each kind of layer's opacity properties, which its zoom fades go in. */
const OPACITY_PROPS: Partial<Record<LayerSpecification['type'], string[]>> = {
  fill: ['fill-opacity'],
  line: ['line-opacity'],
  symbol: ['text-opacity', 'icon-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'],
};

/**
 * How many zooms a layer takes to fade in where it starts and out where it ends: roads and areas
 * over most of a zoom, like Google's map; labels quicker, so they're never long half-readable.
 */
const FADE_ZOOMS: Partial<Record<LayerSpecification['type'], number>> = { fill: 0.75, line: 0.75, symbol: 0.5, circle: 0.5 };

/**
 * Eases a layer in from its first zoom and out before its last, so nothing pops on or off while
 * zooming. A layer whose opacity already changes with zoom (it fades itself) is left as it is.
 */
function withZoomFade(layer: LayerSpecification): LayerSpecification {
  const props = OPACITY_PROPS[layer.type];
  const fade = FADE_ZOOMS[layer.type];
  if (!props || !fade) return layer;
  const start = layer.minzoom && layer.minzoom > 0 ? layer.minzoom : undefined;
  const end = layer.maxzoom && layer.maxzoom < 24 ? layer.maxzoom : undefined;
  if (start === undefined && end === undefined) return layer;
  // A layer shown for less than two fades eases in and out over half its range each.
  const span = start !== undefined && end !== undefined ? Math.min(fade, (end - start) / 2) : fade;
  const paint: Record<string, unknown> = { ...(layer as { paint?: Record<string, unknown> }).paint };
  for (const prop of props) {
    if (prop === 'icon-opacity' && !(layer.layout && 'icon-image' in layer.layout)) continue;
    const value = paint[prop] ?? 1;
    if (typeof value !== 'number') continue;
    const stops: number[] = [];
    if (start !== undefined) stops.push(start, 0, start + span, value);
    if (end !== undefined) stops.push(...(start !== undefined && end - span <= start + span ? [] : [end - span, value]), end, 0);
    paint[prop] = ['interpolate', ['linear'], ['zoom'], ...stops];
  }
  return { ...layer, paint } as LayerSpecification;
}

const styleCache = new Map<string, StyleSpecification>();

/**
 * The base map style for the light or dark version of a map theme, with the transit icons the
 * rider chose (built once each). Hidden icons can't be tapped either.
 */
export function pathlyMapStyle(isDark: boolean, theme: MapTheme = 'default', transitIcons: TransitIcons = 'all'): StyleSpecification {
  const cacheKey = `${theme}-${isDark ? 'dark' : 'light'}-${transitIcons}`;
  const hidden = HIDDEN_STOP_LAYERS[transitIcons];
  const hide = (layer: LayerSpecification): LayerSpecification =>
    hidden.includes(layer.id) ? ({ ...layer, layout: { ...(layer as { layout?: object }).layout, visibility: 'none' } } as LayerSpecification) : layer;
  const cached = styleCache.get(cacheKey);
  if (cached) return cached;
  const palette = mapPalette(isDark, theme);
  const slots: LayerSpecification[] = Array.from({ length: OVERLAY_SLOTS + 1 }, (_, slot) => ({
    id: overlaySlotId(slot),
    type: 'background',
    layout: { visibility: 'none' },
    paint: { 'background-color': palette.land },
  }));
  const style: StyleSpecification = {
    version: 8,
    name: `Pathly ${cacheKey}`,
    sources: {
      // Footpaths come from OpenStreetMap, whose license asks for this credit on the map.
      [SOURCE]: { type: 'vector', tiles: [MAP_TILES_URL], minzoom: 0, maxzoom: TILES_MAX_ZOOM, bounds: TILE_BOUNDS, attribution: MAP_ATTRIBUTION },
    },
    glyphs: MAP_GLYPHS_URL,
    layers: [...baseLayers(palette, isDark).map(withZoomFade).map(hide), ...slots],
  };
  styleCache.set(cacheKey, style);
  return style;
}

/** The map's land color: shown behind the map while its tiles load. */
export function mapLandColor(isDark: boolean, theme: MapTheme = 'default'): string {
  return mapPalette(isDark, theme).land;
}
