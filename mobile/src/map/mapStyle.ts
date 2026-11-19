// Types only (erased from the bundle): the style spec both map libraries render.
import type { ExpressionSpecification, LayerSpecification, StyleSpecification, SymbolLayerSpecification } from '@maplibre/maplibre-gl-style-spec';

import { MAP_EXPLORATION_BOUNDS } from '../data/serviceArea';

/**
 * The base map every Pathly map draws (home, route, trip, and choose-on-map; native and web):
 * Pathly's own vector tiles of New York City, Long Island, and the region around them, built from
 * public-domain government data (Census TIGER/Line streets, water, parks, and places; USGS names;
 * NYC building footprints) by scripts/build-map.mjs, and labeled in Nunito, the app's typeface
 * (scripts/build-map-fonts.mjs). Styled to read like the familiar maps riders know (white streets
 * with gray edges, blue water, green parks) with Pathly's own changes: highways in quiet gray so
 * route lines stand out, no business labels (stations keep theirs), and a dark version.
 *
 * The tiles and fonts are served from Pathly's site. EXPO_PUBLIC_MAP_TILES_URL and
 * EXPO_PUBLIC_MAP_GLYPHS_URL point the map elsewhere (a local copy while building the map, say).
 */

const SITE = 'https://pathly.web.app/map';
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

type Palette = {
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
  stationDot: string;
  stationRing: string;
};

/** Light: the familiar map's colors, highways grayed (they competed with route lines). */
const LIGHT: Palette = {
  land: '#F2F1EB',
  manMade: '#EAE8E2',
  park: '#B5E0A8',
  grass: '#CDEBBF',
  hospital: '#F9D9D5',
  school: '#EFE6D3',
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
  path: '#C9CDD3',
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
  stationDot: '#FFFFFF',
  stationRing: '#5F7189',
};

/** Dark: black and dark-gray surfaces, light-gray labels; water and parks just distinguishable. */
const DARK: Palette = {
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
  path: '#26282D',
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
  stationDot: '#16171A',
  stationRing: '#8E949C',
};

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

const NAME: ExpressionSpecification = ['get', 'name'];
const POINTS: ExpressionSpecification = ['==', ['geometry-type'], 'Point'];
const AREAS: ExpressionSpecification = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];

type RoadKind = { id: string; kinds: string[]; fill: keyof Palette; casing: keyof Palette; minzoom: number; fillWidth: ExpressionSpecification; casingWidth: ExpressionSpecification };

/** Street kinds, least important first so the bigger roads draw over them. */
const ROADS: RoadKind[] = [
  { id: 'path', kinds: ['path'], fill: 'path', casing: 'path', minzoom: 14, fillWidth: width(14, 0.5, 18, 2.5), casingWidth: width(14, 0, 18, 0) },
  { id: 'service', kinds: ['service'], fill: 'minor', casing: 'casing', minzoom: 14, fillWidth: width(14, 0.6, 16, 3, 18, 8), casingWidth: width(14, 1.2, 16, 4.5, 18, 10) },
  { id: 'minor', kinds: ['minor'], fill: 'minor', casing: 'casing', minzoom: 12, fillWidth: width(12, 0.5, 14, 2, 16, 6, 18, 16), casingWidth: width(12, 0.8, 14, 3, 16, 7.5, 18, 18.5) },
  { id: 'tertiary', kinds: ['tertiary'], fill: 'arterial', casing: 'arterialCasing', minzoom: 10, fillWidth: width(10, 0.6, 12, 1.4, 14, 3.5, 16, 8, 18, 20), casingWidth: width(10, 1, 12, 2.2, 14, 5, 16, 10, 18, 23) },
  { id: 'secondary', kinds: ['secondary'], fill: 'arterial', casing: 'arterialCasing', minzoom: 8, fillWidth: width(8, 0.5, 12, 1.8, 14, 4.5, 16, 10, 18, 24), casingWidth: width(8, 0.9, 12, 2.8, 14, 6, 16, 12, 18, 27) },
  { id: 'primary', kinds: ['primary'], fill: 'arterial', casing: 'arterialCasing', minzoom: 6, fillWidth: width(6, 0.5, 10, 1.2, 12, 2.4, 14, 5.5, 16, 12, 18, 28), casingWidth: width(6, 0.9, 10, 2, 12, 3.6, 14, 7.2, 16, 14, 18, 31) },
  { id: 'motorway', kinds: ['motorway'], fill: 'motorway', casing: 'motorwayCasing', minzoom: 4, fillWidth: widthWithLinks(4, 0.5, 10, 1.8, 12, 3.2, 14, 6.5, 16, 14, 18, 32), casingWidth: widthWithLinks(4, 0.8, 10, 2.6, 12, 4.4, 14, 8.4, 16, 16, 18, 35) },
];

function roadLayers(palette: Palette, brunnel: 'tunnel' | 'road' | 'bridge'): LayerSpecification[] {
  const brunnelFilter: ExpressionSpecification = brunnel === 'road'
    ? ['!', ['match', ['get', 'brunnel'], ['tunnel', 'bridge'], true, false]]
    : ['==', ['get', 'brunnel'], brunnel];
  const opacity = brunnel === 'tunnel' ? 0.5 : 1;
  const casings = ROADS.filter((road) => road.id !== 'path').map((road): LayerSpecification => ({
    id: `road-${brunnel}-${road.id}-casing`,
    type: 'line',
    source: SOURCE,
    'source-layer': 'road',
    minzoom: road.minzoom,
    filter: ['all', brunnelFilter, ['match', ['get', 'kind'], road.kinds, true, false]],
    layout: { 'line-cap': brunnel === 'tunnel' ? 'butt' : 'round', 'line-join': 'round' },
    paint: { 'line-color': palette[road.casing], 'line-width': road.casingWidth, 'line-opacity': opacity, ...(brunnel === 'tunnel' ? { 'line-dasharray': [1, 0.5] } : {}) },
  }));
  const fills = ROADS.map((road): LayerSpecification => ({
    id: `road-${brunnel}-${road.id}`,
    type: 'line',
    source: SOURCE,
    'source-layer': 'road',
    minzoom: road.minzoom,
    filter: ['all', brunnelFilter, ['match', ['get', 'kind'], road.kinds, true, false]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': palette[road.fill],
      'line-width': road.fillWidth,
      'line-opacity': opacity,
      ...(road.id === 'path' ? { 'line-dasharray': [2, 1] } : {}),
    },
  }));
  // A bridge draws its own edges and roadway over whatever passes beneath it.
  return brunnel === 'bridge' ? ROADS.flatMap((_, index) => [casings[index - 1], fills[index]].filter((layer): layer is LayerSpecification => layer !== undefined)) : [...casings, ...fills];
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

function baseLayers(palette: Palette, isDark: boolean): LayerSpecification[] {
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
    { id: 'landuse-airport', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 9, filter: ['all', AREAS, ['==', ['get', 'kind'], 'airport']], paint: { 'fill-color': palette.aeroArea } },
    { id: 'landuse-hospital', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 12, filter: ['all', AREAS, ['==', ['get', 'kind'], 'hospital']], paint: { 'fill-color': palette.hospital } },
    { id: 'landuse-school', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 12, filter: ['all', AREAS, ['match', ['get', 'kind'], ['school', 'university'], true, false]], paint: { 'fill-color': palette.school } },
    { id: 'landuse-cemetery', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 11, filter: ['all', AREAS, ['==', ['get', 'kind'], 'cemetery']], paint: { 'fill-color': palette.grass } },
    { id: 'landuse-recreation', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 12, filter: ['all', AREAS, ['match', ['get', 'kind'], ['theme_park', 'zoo'], true, false]], paint: { 'fill-color': palette.grass } },
    { id: 'park', type: 'fill', source: SOURCE, 'source-layer': 'park', filter: ['all', AREAS, ['match', ['get', 'kind'], ['park', 'national_park'], true, false]], paint: { 'fill-color': palette.park } },
    { id: 'park-golf', type: 'fill', source: SOURCE, 'source-layer': 'park', minzoom: 10, filter: ['all', AREAS, ['==', ['get', 'kind'], 'golf_course']], paint: { 'fill-color': palette.grass } },
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
    {
      id: 'road-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'road',
      minzoom: 13,
      filter: ['all', ['has', 'name'], ['match', ['get', 'kind'], ['motorway', 'primary', 'secondary', 'tertiary', 'minor', 'service'], true, false]],
      layout: {
        'symbol-placement': 'line',
        'text-field': NAME,
        'text-font': REGULAR,
        'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 12.5, 18, 14],
        'text-padding': 4,
        'symbol-spacing': 280,
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'viewport',
      },
      paint: { 'text-color': palette.roadLabel, ...halo },
    },
    {
      // Rail and subway stations and ferry landings keep their names (businesses' are hidden).
      id: 'station-dot',
      type: 'circle',
      source: SOURCE,
      'source-layer': 'poi',
      minzoom: 14,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 3, 17, 4.5],
        'circle-color': palette.stationDot,
        'circle-stroke-color': palette.stationRing,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14, 1.3, 17, 2],
      },
    },
    {
      id: 'station-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'poi',
      minzoom: 14,
      layout: {
        'text-field': NAME,
        'text-font': BOLD,
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10.5, 17, 12.5],
        'text-anchor': 'top',
        'text-offset': [0, 0.6],
        'text-max-width': 8,
        'text-padding': 4,
      },
      paint: { 'text-color': palette.stationLabel, ...halo },
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
      minzoom: 13,
      maxzoom: 17,
      filter: ['==', ['get', 'kind'], 'neighbourhood'],
      layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 16, 12.5], 'text-max-width': 7, 'text-padding': 6 },
      paint: { 'text-color': palette.neighborhoodLabel, ...halo },
    },
    {
      id: 'place-village',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 11,
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

const styleCache = new Map<boolean, StyleSpecification>();

/** The base map style for the light or dark theme (built once per theme). */
export function pathlyMapStyle(isDark: boolean): StyleSpecification {
  const cached = styleCache.get(isDark);
  if (cached) return cached;
  const palette = isDark ? DARK : LIGHT;
  const slots: LayerSpecification[] = Array.from({ length: OVERLAY_SLOTS + 1 }, (_, slot) => ({
    id: overlaySlotId(slot),
    type: 'background',
    layout: { visibility: 'none' },
    paint: { 'background-color': palette.land },
  }));
  const style: StyleSpecification = {
    version: 8,
    name: isDark ? 'Pathly dark' : 'Pathly light',
    sources: {
      [SOURCE]: { type: 'vector', tiles: [MAP_TILES_URL], minzoom: 0, maxzoom: TILES_MAX_ZOOM, bounds: TILE_BOUNDS },
    },
    glyphs: MAP_GLYPHS_URL,
    layers: [...baseLayers(palette, isDark), ...slots],
  };
  styleCache.set(isDark, style);
  return style;
}

/** The map's land color: shown behind the map while its tiles load. */
export function mapLandColor(isDark: boolean): string {
  return (isDark ? DARK : LIGHT).land;
}
