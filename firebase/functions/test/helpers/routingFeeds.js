/**
 * Small synthetic feeds for the trip planner's tests, built through the same prepared-data build
 * as real feeds (gtfsDerivedBuild.ts -> routing.bin) and merged into one TransitNetwork.
 *
 * Subway (agency "subway"), north along one avenue, A1 -> A4 about 1.1 km apart:
 *   A  local, every 10 minutes 08:00-09:50, 4 minutes between stops, following shape SA.
 *   X  express A1 -> A4 non-stop in 6 minutes at 08:05 and 08:35; boards only at A1, lets off only at A4.
 *   N  one night trip A1 -> A4 at 24:30 (00:30 the next morning) on the weekday service.
 * Bus (agency "nice"), east along a street that crosses the avenue just west of A3:
 *   B  B1 -> B3 every 15 minutes 08:00-09:45, 5 minutes between stops.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildDerivedData } = require('../../lib/gtfsDerivedBuild');
const { decodeRoutingTimetable } = require('../../lib/routingTimetable');
const { TransitNetwork } = require('../../lib/transitNetwork');

const clock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
const CALENDAR = 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260101,20271231\n';

const STOPS = {
  A1: [40.70, -73.90], A2: [40.71, -73.90], A3: [40.72, -73.90], A4: [40.73, -73.90],
  B1: [40.72, -73.903], B2: [40.72, -73.89], B3: [40.72, -73.88],
};

function subwayFeed() {
  const trips = ['route_id,service_id,trip_id,trip_headsign,direction_id,shape_id'];
  const times = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type'];
  for (let start = 8 * 60; start < 10 * 60; start += 10) {
    const id = `A-${clock(start)}`;
    trips.push(`A,WK,${id},Fourth Av,0,SA`);
    ['A1', 'A2', 'A3', 'A4'].forEach((stop, index) => times.push(`${id},${clock(start + index * 4)},${clock(start + index * 4)},${stop},${index + 1},0,0`));
  }
  for (const start of [8 * 60 + 5, 8 * 60 + 35]) {
    const id = `X-${clock(start)}`;
    trips.push(`X,WK,${id},Fourth Av Express,0,`);
    times.push(`${id},${clock(start)},${clock(start)},A1,1,0,1`, `${id},${clock(start + 6)},${clock(start + 6)},A4,2,1,0`);
  }
  trips.push('N,WK,N-2430,Fourth Av,0,');
  times.push('N-2430,24:30:00,24:30:00,A1,1,0,0', 'N-2430,24:42:00,24:42:00,A4,2,0,0');
  return {
    'agency.txt': 'agency_id,agency_name,agency_url\nMTA NYCT,MTA New York City Transit,https://www.mta.info\n',
    'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\nA,MTA NYCT,A,Avenue Local,1,FF0000,FFFFFF\nX,MTA NYCT,X,Avenue Express,1,00AA00,000000\nN,MTA NYCT,N,Night Owl,1,0000FF,FFFFFF\n',
    'stops.txt': `stop_id,stop_name,stop_lat,stop_lon\n${['A1', 'A2', 'A3', 'A4'].map((id, index) => `${id},${['First Av', 'Second Av', 'Third Av', 'Fourth Av'][index]},${STOPS[id][0]},${STOPS[id][1]}`).join('\n')}\n`,
    'trips.txt': `${trips.join('\n')}\n`,
    'stop_times.txt': `${times.join('\n')}\n`,
    'calendar.txt': CALENDAR,
    // A bend between each pair of stations, so the line drawn follows the shape, not the stops.
    'shapes.txt': `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n${[[40.70, -73.90], [40.705, -73.899], [40.71, -73.90], [40.715, -73.899], [40.72, -73.90], [40.725, -73.899], [40.73, -73.90]].map(([lat, lon], index) => `SA,${lat},${lon},${index + 1}`).join('\n')}\n`,
  };
}

function busFeed() {
  const trips = ['route_id,service_id,trip_id,trip_headsign,direction_id'];
  const times = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence'];
  for (let start = 8 * 60; start < 10 * 60; start += 15) {
    const id = `B-${clock(start)}`;
    trips.push(`B,WK,${id},EAST ST,0`);
    ['B1', 'B2', 'B3'].forEach((stop, index) => times.push(`${id},${clock(start + index * 5)},${clock(start + index * 5)},${stop},${index + 1}`));
  }
  return {
    'agency.txt': 'agency_id,agency_name,agency_url\nLIBUS,Nassau Inter-County Express,http://www.nicebus.com\n',
    'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\nB,LIBUS,n1,Crosstown,3,60AA47,FFFFFF\n',
    'stops.txt': `stop_id,stop_name,stop_lat,stop_lon\n${['B1', 'B2', 'B3'].map((id, index) => `${id},${['West St', 'Middle St', 'East St'][index]},${STOPS[id][0]},${STOPS[id][1]}`).join('\n')}\n`,
    'trips.txt': `${trips.join('\n')}\n`,
    'stop_times.txt': `${times.join('\n')}\n`,
    'calendar.txt': CALENDAR,
  };
}

function writeFeed(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
}

/** Builds a feed's routing timetable the way a deploy does, and decodes it. */
async function buildTimetable(agencyId, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pathly-routing-'));
  try {
    writeFeed(path.join(root, 'feed'), files);
    await buildDerivedData(agencyId, path.join(root, 'feed'), path.join(root, 'derived'));
    return decodeRoutingTimetable(fs.readFileSync(path.join(root, 'derived', 'routing.bin')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** The subway and bus feeds above as one network. */
async function buildTestNetwork() {
  const [subway, bus] = await Promise.all([buildTimetable('subway', subwayFeed()), buildTimetable('nice', busFeed())]);
  return new TransitNetwork([{ agencyId: 'subway', version: 'test', timetable: subway }, { agencyId: 'nice', version: 'test', timetable: bus }]);
}

/** A stop's network index by its feed id. */
function stopIndex(network, stopId) {
  for (let stop = 0; stop < network.stopCount; stop += 1) if (network.stopId(stop) === stopId) return stop;
  throw new Error(`no stop ${stopId}`);
}

/** Wednesday, November 18, 2026 in New York, at a clock time: an instant. */
const wednesdayAt = (hours, minutes = 0) => Date.UTC(2026, 10, 18, hours + 5, minutes);

module.exports = { STOPS, buildTestNetwork, buildTimetable, busFeed, clock, stopIndex, subwayFeed, wednesdayAt, writeFeed };
