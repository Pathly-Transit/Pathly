import type { ImageRequireSource } from 'react-native';

/**
 * The base map's transit icons (scripts/build-map-icons.mjs draws them), by the names the style
 * uses (mapStyle.ts's transitIconName). The phone's copies come in @2x and @3x too and the phone
 * picks its scale; the web's are drawn at WEB_ICON_PIXEL_RATIO.
 */
export const MAP_ICONS: Record<string, ImageRequireSource> = {
  'transit-subway': require('../../assets/map-icons/transit-subway.png'),
  'transit-rail': require('../../assets/map-icons/transit-rail.png'),
  'transit-ferry': require('../../assets/map-icons/transit-ferry.png'),
  'transit-bus': require('../../assets/map-icons/transit-bus.png'),
  'transit-subway-dark': require('../../assets/map-icons/transit-subway-dark.png'),
  'transit-rail-dark': require('../../assets/map-icons/transit-rail-dark.png'),
  'transit-ferry-dark': require('../../assets/map-icons/transit-ferry-dark.png'),
  'transit-bus-dark': require('../../assets/map-icons/transit-bus-dark.png'),
  'oneway-arrow': require('../../assets/map-icons/oneway-arrow.png'),
  'oneway-arrow-dark': require('../../assets/map-icons/oneway-arrow-dark.png'),
  // The rider's heading beam (MapLocationDot on the phone).
  'heading-beam': require('../../assets/map-icons/heading-beam.png'),
};

export const WEB_MAP_ICONS: Record<string, ImageRequireSource> = {
  'transit-subway': require('../../assets/map-icons/web/transit-subway.png'),
  'transit-rail': require('../../assets/map-icons/web/transit-rail.png'),
  'transit-ferry': require('../../assets/map-icons/web/transit-ferry.png'),
  'transit-bus': require('../../assets/map-icons/web/transit-bus.png'),
  'transit-subway-dark': require('../../assets/map-icons/web/transit-subway-dark.png'),
  'transit-rail-dark': require('../../assets/map-icons/web/transit-rail-dark.png'),
  'transit-ferry-dark': require('../../assets/map-icons/web/transit-ferry-dark.png'),
  'transit-bus-dark': require('../../assets/map-icons/web/transit-bus-dark.png'),
  'oneway-arrow': require('../../assets/map-icons/web/oneway-arrow.png'),
  'oneway-arrow-dark': require('../../assets/map-icons/web/oneway-arrow-dark.png'),
};

export const WEB_ICON_PIXEL_RATIO = 3;
