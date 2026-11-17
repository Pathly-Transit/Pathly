// Types only (erased from the bundle): the style spec both map libraries render.
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

/**
 * The base map every Pathly map draws (home, route, trip, and choose-on-map; native and web):
 * OpenStreetMap's streets, buildings, water, parks, and places as vector tiles in the
 * OpenMapTiles schema, styled here to read like the familiar maps riders know — white streets
 * with gray edges, blue water, green parks — with Pathly's own changes: highways in quiet gray so
 * route lines stand out, no business or attraction labels (stations keep theirs), and a dark
 * version for the dark theme.
 *
 * Tiles come from OpenFreeMap (openfreemap.org: free, no key, no request limits, refreshed from
 * OpenStreetMap every week). EXPO_PUBLIC_MAP_TILES_URL and EXPO_PUBLIC_MAP_GLYPHS_URL point the
 * map at another OpenMapTiles-schema source instead (a self-hosted copy, for instance). The
 * attribution OpenStreetMap's license requires is shown on every map.
 */

const DEFAULT_TILES_URL = 'https://tiles.openfreemap.org/planet';
const DEFAULT_GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
export const MAP_TILES_URL = process.env.EXPO_PUBLIC_MAP_TILES_URL || DEFAULT_TILES_URL;
const MAP_GLYPHS_URL = process.env.EXPO_PUBLIC_MAP_GLYPHS_URL || DEFAULT_GLYPHS_URL;
export const MAP_ATTRIBUTION = '© OpenStreetMap contributors · © OpenMapTiles · OpenFreeMap';

/**
 * Empty layers at the top of the style that Pathly's own lines and dots are slotted beneath
 * (map/MapCanvas: a layer with zIndex z goes just under slot z + 1), so they always draw above the
 * base map and in a fixed order among themselves, whenever each is added.
 */
export const OVERLAY_SLOTS = 8;
export const overlaySlotId = (slot: number) => `pathly-slot-${Math.max(0, Math.min(OVERLAY_SLOTS, slot))}`;

const SOURCE = 'openmaptiles';
const REGULAR = ['Noto Sans Regular'];
const BOLD = ['Noto Sans Bold'];
const ITALIC = ['Noto Sans Italic'];

type Palette = {
  land: string;
  manMade: string;
  park: string;
  wood: string;
  grass: string;
  hospital: string;
  school: string;
  sand: string;
  water: string;
  aeroArea: string;
  runway: string;
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
  stationLabel: string;
  stationDot: string;
  stationRing: string;
  houseNumber: string;
};

/** Light: the familiar map's colors, highways grayed (they competed with route lines). */
const LIGHT: Palette = {
  land: '#F3F2EF',
  manMade: '#EDECE9',
  park: '#CBEAC2',
  wood: '#D2EBC8',
  grass: '#DCEFD3',
  hospital: '#FBE7E5',
  school: '#F0ECE4',
  sand: '#F6EFD2',
  water: '#A8D0F2',
  aeroArea: '#E8E8EA',
  runway: '#D7D9DD',
  building: '#E6E4E0',
  buildingOutline: '#D8D6D1',
  casing: '#DADCE0',
  minor: '#FFFFFF',
  arterial: '#FFFFFF',
  arterialCasing: '#CDD0D4',
  highway: '#DADCE0',
  highwayCasing: '#C4C7CC',
  motorway: '#DADCE0',
  motorwayCasing: '#BDC1C6',
  path: '#D9DCE0',
  rail: '#B9BDC2',
  ferry: '#6FA3D8',
  boundary: '#B6BAC0',
  label: '#5F6368',
  labelHalo: '#FFFFFF',
  placeLabel: '#3C4043',
  neighborhoodLabel: '#7A7F86',
  roadLabel: '#5F6368',
  waterLabel: '#3F77B0',
  stationLabel: '#3C4F66',
  stationDot: '#FFFFFF',
  stationRing: '#5F7189',
  houseNumber: '#9AA0A6',
};

/** Dark: black and dark-gray surfaces, light-gray labels; water and parks just distinguishable. */
const DARK: Palette = {
  land: '#16171A',
  manMade: '#1B1C1F',
  park: '#18241C',
  wood: '#18241C',
  grass: '#18221B',
  hospital: '#1E1B1D',
  school: '#1C1C1F',
  sand: '#1E1D19',
  water: '#0D1724',
  aeroArea: '#1B1C1F',
  runway: '#2A2D33',
  building: '#1E1F23',
  buildingOutline: '#25272C',
  casing: '#1B1C1F',
  minor: '#2A2D33',
  arterial: '#32353C',
  arterialCasing: '#1B1C1F',
  highway: '#3C4048',
  highwayCasing: '#1B1C1F',
  motorway: '#454A53',
  motorwayCasing: '#1B1C1F',
  path: '#26282D',
  rail: '#2A2D33',
  ferry: '#284B70',
  boundary: '#3A3D42',
  label: '#8E949C',
  labelHalo: '#16171A',
  placeLabel: '#B3B9C1',
  neighborhoodLabel: '#80868E',
  roadLabel: '#9AA0A8',
  waterLabel: '#4E6A88',
  stationLabel: '#B3B9C1',
  stationDot: '#16171A',
  stationRing: '#8E949C',
  houseNumber: '#5F656D',
};

/** A line width growing with zoom (each step up doubles the scale, so widths grow ~1.5x per zoom). */
function width(...stops: number[]): ExpressionSpecification {
  return ['interpolate', ['exponential', 1.5], ['zoom'], ...stops] as ExpressionSpecification;
}

const NAME: ExpressionSpecification = ['coalesce', ['get', 'name_en'], ['get', 'name']];

type RoadKind = { id: string; classes: string[]; fill: keyof Palette; casing: keyof Palette; minzoom: number; fillWidth: ExpressionSpecification; casingWidth: ExpressionSpecification };

/** Street classes, least important first so the bigger roads draw over them. */
const ROADS: RoadKind[] = [
  { id: 'path', classes: ['path', 'track'], fill: 'path', casing: 'path', minzoom: 14, fillWidth: width(14, 0.5, 18, 2.5), casingWidth: width(14, 0, 18, 0) },
  { id: 'service', classes: ['service'], fill: 'minor', casing: 'casing', minzoom: 14, fillWidth: width(14, 0.6, 16, 3, 18, 8), casingWidth: width(14, 1.2, 16, 4.5, 18, 10) },
  { id: 'minor', classes: ['minor', 'busway'], fill: 'minor', casing: 'casing', minzoom: 12, fillWidth: width(12, 0.5, 14, 2, 16, 6, 18, 16), casingWidth: width(12, 0.8, 14, 3, 16, 7.5, 18, 18.5) },
  { id: 'tertiary', classes: ['tertiary'], fill: 'arterial', casing: 'arterialCasing', minzoom: 10, fillWidth: width(10, 0.6, 12, 1.4, 14, 3.5, 16, 8, 18, 20), casingWidth: width(10, 1, 12, 2.2, 14, 5, 16, 10, 18, 23) },
  { id: 'secondary', classes: ['secondary'], fill: 'arterial', casing: 'arterialCasing', minzoom: 9, fillWidth: width(9, 0.6, 12, 1.8, 14, 4.5, 16, 10, 18, 24), casingWidth: width(9, 1, 12, 2.8, 14, 6, 16, 12, 18, 27) },
  { id: 'primary', classes: ['primary'], fill: 'arterial', casing: 'arterialCasing', minzoom: 7, fillWidth: width(7, 0.5, 10, 1.2, 12, 2.4, 14, 5.5, 16, 12, 18, 28), casingWidth: width(7, 0.9, 10, 2, 12, 3.6, 14, 7.2, 16, 14, 18, 31) },
  { id: 'trunk', classes: ['trunk'], fill: 'highway', casing: 'highwayCasing', minzoom: 5, fillWidth: width(5, 0.5, 10, 1.6, 12, 3, 14, 6, 16, 13, 18, 30), casingWidth: width(5, 0.8, 10, 2.4, 12, 4.2, 14, 7.8, 16, 15, 18, 33) },
  { id: 'motorway', classes: ['motorway'], fill: 'motorway', casing: 'motorwayCasing', minzoom: 4, fillWidth: width(4, 0.5, 10, 1.8, 12, 3.2, 14, 6.5, 16, 14, 18, 32), casingWidth: width(4, 0.8, 10, 2.6, 12, 4.4, 14, 8.4, 16, 16, 18, 35) },
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
    'source-layer': 'transportation',
    minzoom: road.minzoom,
    filter: ['all', brunnelFilter, ['match', ['get', 'class'], road.classes, true, false]],
    layout: { 'line-cap': brunnel === 'tunnel' ? 'butt' : 'round', 'line-join': 'round' },
    paint: { 'line-color': palette[road.casing], 'line-width': road.casingWidth, 'line-opacity': opacity, ...(brunnel === 'tunnel' ? { 'line-dasharray': [1, 0.5] } : {}) },
  }));
  const fills = ROADS.map((road): LayerSpecification => ({
    id: `road-${brunnel}-${road.id}`,
    type: 'line',
    source: SOURCE,
    'source-layer': 'transportation',
    minzoom: road.minzoom,
    filter: ['all', brunnelFilter, ['match', ['get', 'class'], road.classes, true, false]],
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

function baseLayers(palette: Palette, isDark: boolean): LayerSpecification[] {
  return [
    { id: 'background', type: 'background', paint: { 'background-color': palette.land } },
    {
      id: 'landuse-man-made',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'landuse',
      filter: ['match', ['get', 'class'], ['residential', 'commercial', 'industrial', 'retail', 'railway', 'garages', 'quarry'], true, false],
      paint: { 'fill-color': palette.manMade, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0, 11, 0.7] },
    },
    { id: 'landuse-hospital', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 12, filter: ['==', ['get', 'class'], 'hospital'], paint: { 'fill-color': palette.hospital } },
    { id: 'landuse-school', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 12, filter: ['match', ['get', 'class'], ['school', 'university', 'college', 'kindergarten'], true, false], paint: { 'fill-color': palette.school } },
    { id: 'landuse-cemetery', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 11, filter: ['==', ['get', 'class'], 'cemetery'], paint: { 'fill-color': palette.grass } },
    { id: 'landcover-wood', type: 'fill', source: SOURCE, 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'wood'], paint: { 'fill-color': palette.wood } },
    { id: 'landcover-grass', type: 'fill', source: SOURCE, 'source-layer': 'landcover', minzoom: 10, filter: ['match', ['get', 'class'], ['grass', 'farmland', 'wetland'], true, false], paint: { 'fill-color': palette.grass, 'fill-opacity': 0.8 } },
    { id: 'landcover-sand', type: 'fill', source: SOURCE, 'source-layer': 'landcover', minzoom: 10, filter: ['==', ['get', 'class'], 'sand'], paint: { 'fill-color': palette.sand } },
    { id: 'landuse-recreation', type: 'fill', source: SOURCE, 'source-layer': 'landuse', minzoom: 12, filter: ['match', ['get', 'class'], ['pitch', 'playground', 'stadium', 'zoo', 'theme_park'], true, false], paint: { 'fill-color': palette.grass } },
    { id: 'park', type: 'fill', source: SOURCE, 'source-layer': 'park', paint: { 'fill-color': palette.park } },
    { id: 'water', type: 'fill', source: SOURCE, 'source-layer': 'water', filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-color': palette.water } },
    {
      id: 'waterway',
      type: 'line',
      source: SOURCE,
      'source-layer': 'waterway',
      minzoom: 8,
      filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      layout: { 'line-cap': 'round' },
      // Rivers and canals wider than streams; zoom must be the outermost curve.
      paint: {
        'line-color': palette.water,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, ['match', ['get', 'class'], ['river', 'canal'], 0.6, 0], 12, ['match', ['get', 'class'], ['river', 'canal'], 1.8, 0.4], 14, ['match', ['get', 'class'], ['river', 'canal'], 3, 1], 18, ['match', ['get', 'class'], ['river', 'canal'], 12, 4]],
      },
    },
    { id: 'aeroway-area', type: 'fill', source: SOURCE, 'source-layer': 'aeroway', minzoom: 10, filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false], paint: { 'fill-color': palette.aeroArea } },
    {
      id: 'aeroway-runway',
      type: 'line',
      source: SOURCE,
      'source-layer': 'aeroway',
      minzoom: 11,
      filter: ['all', ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false], ['match', ['get', 'class'], ['runway', 'taxiway'], true, false]],
      paint: {
        'line-color': palette.runway,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, ['match', ['get', 'class'], 'runway', 2, 0.2], 14, ['match', ['get', 'class'], 'runway', 12, 3], 18, ['match', ['get', 'class'], 'runway', 80, 20]],
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
      'source-layer': 'transportation',
      minzoom: 10,
      // Subways run underground, where a street map doesn't draw them.
      filter: ['all', ['==', ['get', 'class'], 'rail'], ['!=', ['get', 'brunnel'], 'tunnel']],
      paint: { 'line-color': palette.rail, 'line-width': width(10, 0.6, 14, 1.4, 18, 3) },
    },
    {
      id: 'railway-hatching',
      type: 'line',
      source: SOURCE,
      'source-layer': 'transportation',
      minzoom: 14,
      filter: ['all', ['==', ['get', 'class'], 'rail'], ['!=', ['get', 'brunnel'], 'tunnel']],
      paint: { 'line-color': palette.rail, 'line-width': width(14, 3, 18, 8), 'line-dasharray': [0.2, 4] },
    },
    ...roadLayers(palette, 'bridge'),
    {
      id: 'ferry',
      type: 'line',
      source: SOURCE,
      'source-layer': 'transportation',
      minzoom: 12,
      filter: ['==', ['get', 'class'], 'ferry'],
      paint: { 'line-color': palette.ferry, 'line-width': width(12, 0.7, 16, 1.6), 'line-dasharray': [3, 2], 'line-opacity': 0.7 },
    },
    {
      id: 'boundary-state',
      type: 'line',
      source: SOURCE,
      'source-layer': 'boundary',
      filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
      paint: { 'line-color': palette.boundary, 'line-width': width(4, 0.6, 12, 1.6), 'line-dasharray': [3, 2] },
    },
    {
      id: 'boundary-county',
      type: 'line',
      source: SOURCE,
      'source-layer': 'boundary',
      minzoom: 9,
      filter: ['all', ['==', ['get', 'admin_level'], 6], ['!=', ['get', 'maritime'], 1]],
      paint: { 'line-color': palette.boundary, 'line-width': width(9, 0.5, 14, 1.2), 'line-dasharray': [2, 2], 'line-opacity': 0.7 },
    },
    {
      id: 'waterway-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'waterway',
      minzoom: 13,
      filter: ['match', ['get', 'class'], ['river', 'canal'], true, false],
      layout: { 'symbol-placement': 'line', 'text-field': NAME, 'text-font': ITALIC, 'text-size': 12, 'text-letter-spacing': 0.1 },
      paint: { 'text-color': palette.waterLabel, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.2 },
    },
    ...(['point', 'line'] as const).map((placement): LayerSpecification => ({
      id: `water-label-${placement}`,
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'water_name',
      minzoom: 9,
      filter: ['match', ['geometry-type'], placement === 'line' ? ['LineString', 'MultiLineString'] : ['Point', 'MultiPoint'], true, false],
      layout: {
        'text-field': NAME,
        'text-font': ITALIC,
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 14, 14],
        'text-max-width': 8,
        'text-letter-spacing': 0.05,
        'symbol-placement': placement,
      },
      paint: { 'text-color': palette.waterLabel, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.2 },
    })),
    {
      id: 'road-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'transportation_name',
      minzoom: 13,
      filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'], true, false],
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
      paint: { 'text-color': palette.roadLabel, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.5 },
    },
    {
      id: 'housenumber',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'housenumber',
      minzoom: 17,
      layout: { 'text-field': ['get', 'housenumber'], 'text-font': REGULAR, 'text-size': 10, 'text-padding': 2 },
      paint: { 'text-color': palette.houseNumber, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1 },
    },
    {
      // Rail and subway stations and ferry terminals keep their names (other places' are hidden).
      id: 'station-dot',
      type: 'circle',
      source: SOURCE,
      'source-layer': 'poi',
      minzoom: 14,
      filter: ['any', ['all', ['==', ['get', 'class'], 'railway'], ['match', ['get', 'subclass'], ['station', 'halt', 'subway'], true, false]], ['==', ['get', 'class'], 'ferry_terminal']],
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
      filter: ['any', ['all', ['==', ['get', 'class'], 'railway'], ['match', ['get', 'subclass'], ['station', 'halt', 'subway'], true, false]], ['==', ['get', 'class'], 'ferry_terminal']],
      layout: {
        'text-field': NAME,
        'text-font': BOLD,
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10.5, 17, 12.5],
        'text-anchor': 'top',
        'text-offset': [0, 0.6],
        'text-max-width': 8,
        'text-padding': 4,
      },
      paint: { 'text-color': palette.stationLabel, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.5 },
    },
    {
      id: 'airport-label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'aerodrome_label',
      minzoom: 10,
      filter: ['match', ['get', 'class'], ['international', 'public', 'regional'], true, false],
      layout: { 'text-field': NAME, 'text-font': BOLD, 'text-size': 11, 'text-max-width': 8 },
      paint: { 'text-color': palette.label, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.5 },
    },
    {
      id: 'place-neighborhood',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 13,
      maxzoom: 17,
      filter: ['match', ['get', 'class'], ['neighbourhood', 'quarter'], true, false],
      layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 16, 12.5], 'text-max-width': 7, 'text-padding': 6 },
      paint: { 'text-color': palette.neighborhoodLabel, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.5 },
    },
    {
      id: 'place-suburb',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 11,
      maxzoom: 16,
      filter: ['match', ['get', 'class'], ['suburb', 'borough'], true, false],
      layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 15, 14], 'text-max-width': 7, 'text-padding': 6, 'symbol-sort-key': ['get', 'rank'] },
      paint: { 'text-color': palette.neighborhoodLabel, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.5 },
    },
    {
      id: 'place-village',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 11,
      maxzoom: 16,
      filter: ['match', ['get', 'class'], ['village', 'hamlet'], true, false],
      layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10.5, 15, 13.5], 'text-max-width': 7, 'text-padding': 8, 'symbol-sort-key': ['get', 'rank'] },
      paint: { 'text-color': palette.label, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.5 },
    },
    {
      id: 'place-town',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 8,
      maxzoom: 15,
      filter: ['==', ['get', 'class'], 'town'],
      layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 15], 'text-max-width': 8, 'symbol-sort-key': ['get', 'rank'] },
      paint: { 'text-color': palette.placeLabel, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.5 },
    },
    {
      id: 'place-city',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 5,
      maxzoom: 14,
      filter: ['==', ['get', 'class'], 'city'],
      layout: { 'text-field': NAME, 'text-font': BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 5, 11, 10, 16, 13, 19], 'text-max-width': 8, 'symbol-sort-key': ['get', 'rank'] },
      paint: { 'text-color': palette.placeLabel, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.8 },
    },
    {
      id: 'place-state',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 4,
      maxzoom: 9,
      filter: ['==', ['get', 'class'], 'state'],
      layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 14], 'text-transform': 'uppercase', 'text-letter-spacing': 0.15, 'text-max-width': 8 },
      paint: { 'text-color': isDark ? '#6B7179' : '#9AA0A6', 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.2 },
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
      [SOURCE]: { type: 'vector', url: MAP_TILES_URL, attribution: MAP_ATTRIBUTION },
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
