// Pathly's map schema: the layers the base map's tiles carry (mobile/src/map/mapStyle.ts draws them).
//
//   sea         the sea: one square per tile, under everything (the land is drawn over it)
//   land        the land: the states' outlines merged, less their water
//   water       lakes, rivers, bays, and the sea near shore, merged into one surface
//   landuse     kind: airport, cemetery, hospital, university, school, military, commercial,
//               industrial, theme_park, zoo; airport names as points (kind airport, name)
//   park        kind: park, national_park, golf_course; park names as points (kind park, name)
//   building    building outlines
//   road        kind: motorway, primary, secondary, tertiary, minor, service, path; link (ramps),
//               brunnel (bridge/tunnel), name, ref (route number)
//   rail        railroads
//   waterway    kind: river, canal, stream; name
//   ferry       ferry routes
//   boundary    state lines
//   place       kind: state, city, town, village, hamlet, borough, neighbourhood, island; name, rank
//   water_name  kind: ocean, bay, lake, river, channel; name
//   poi         stations: kind subway, rail, ferry; name
//
// A label too small to show at the tiles' last zoom carries `lz`, the zoom it shows from.

// (Stored by index: add new layers at the end, so features read earlier keep theirs.)
export const LAYERS = ['land', 'water', 'landuse', 'park', 'building', 'road', 'rail', 'waterway', 'ferry', 'boundary', 'place', 'water_name', 'poi', 'sea'];

// TIGER/Line abbreviates names to fit its fields; the labels spell them out where the familiar
// maps do (street suffixes like St and Ave stay short, as they do there).
const WORDS = {
  Brg: 'Bridge', Tunl: 'Tunnel',
  Riv: 'River', Crk: 'Creek', Brk: 'Brook', Lk: 'Lake', Lks: 'Lakes', Cnl: 'Canal', Chnnl: 'Channel', Chnl: 'Channel',
  Inlt: 'Inlet', Cv: 'Cove', Hbr: 'Harbor', Snd: 'Sound', Res: 'Reservoir', Drn: 'Drain', Pnt: 'Point', Bch: 'Beach',
  Is: 'Island', Iss: 'Islands', Natl: 'National', Rec: 'Recreation', Hist: 'Historic', Mem: 'Memorial', Pk: 'Park',
  Cmtry: 'Cemetery', Cementary: 'Cemetery', Colg: 'College', Univ: 'University', Schl: 'School', Hosp: 'Hospital',
  Mt: 'Mount', Ft: 'Fort', Arpt: 'Airport', Intl: 'International', Co: 'County', Pres: 'Preserve', Fld: 'Field',
};

export function spellOut(name, { roads = false } = {}) {
  if (!name) return name;
  const words = name.split(' ');
  return words
    .map((word, i) => {
      if (roads && word !== 'Brg' && word !== 'Tunl') return word;
      // "St" is Saint before a name and State in "St Pk"; elsewhere left alone.
      if (word === 'St' && !roads) return words[i + 1] === 'Pk' || words[i + 1] === 'Park' ? 'State' : 'St.';
      return WORDS[word] ?? word;
    })
    .join(' ');
}

/** For matching names across datasets: lowercase, spelled out, no punctuation. */
export function nameKey(name) {
  return spellOut(name).toLowerCase().replace(/^the /, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
