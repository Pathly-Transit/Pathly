const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const defaults = config.resolver.blockList;

// Expo's development env context matches every .env* filename. Release inputs are
// loaded by scripts/ios-eas.mjs and must stay outside the application bundle.
config.resolver.blockList = [
  ...(Array.isArray(defaults) ? defaults : defaults ? [defaults] : []),
  /(^|[\\/])\.env\.testflight\.local$/,
  /(^|[\\/])\.credentials([\\/]|$)/,
];

module.exports = config;
