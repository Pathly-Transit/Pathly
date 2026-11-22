import { MTA_BUS_AGENCY_IDS, type AgencyId } from './gtfsAgencies';
import type { TransitStep } from './tripPlanning';

/** Google's agency names, as Routes API transit steps report them. */
export const LIRR_AGENCY = 'Long Island Rail Road';
export const METRO_NORTH_AGENCY = 'Metro-North Railroad';
export const NYCT_AGENCY = 'MTA New York City Transit';
export const NICE_AGENCY = 'Nassau Inter-County Express';
export const MTA_BUS_COMPANY_AGENCY = 'MTA Bus Company';
export const NYC_FERRY_AGENCY = 'NYC Ferry';
/** Google's agency for MTA buses on Staten Island (and some express routes), seen 2026-10-28. */
export const MTA_AGENCY = 'MTA';

/** NYC Ferry, also when Google adds its operator ("NYC Ferry by Hornblower"). */
export const isNycFerry = (agency: string) => agency.toLowerCase().startsWith('nyc ferry');
/** NYC DOT's Staten Island Ferry: Google names its agency "New York City Department of Transportation". */
export const isStatenIslandFerry = (step: Pick<TransitStep, 'agency' | 'mode' | 'line'>) =>
  step.mode === 'ferry' && (/department of transportation|nyc dot/i.test(step.agency.name) || /staten island ferry/i.test(step.line.name));

/** Google's name for MTA Bus Company varies in case ("Mta Bus Company"). */
const isMtaBusCompany = (agency: string) => agency.toLowerCase() === MTA_BUS_COMPANY_AGENCY.toLowerCase();

/** Google splits Suffolk County Transit by area ("Suffolk County Transit - West", ...). */
export const isSuffolk = (agency: string) => agency === 'Suffolk County Transit' || agency.startsWith('Suffolk County Transit -');

/** Google has used both the MTA's official name and its shorter railroad name. */
export const isMetroNorth = (agency: string) => /metro[\s-]*north|\bmnr\b/i.test(agency);

/** PATH: Google names it "PATH" or by the Port Authority's full name for it. */
export const isPath = (agency: string) => /^path$|port authority trans[\s-]*hudson/i.test(agency.trim());

type StepLine = { line?: { name?: string; shortName?: string } };

/**
 * The rider-facing mode of a step on an agency whose vehicles Google may type loosely: PATH rides
 * as rapid transit (subway). Other steps keep the mode of their vehicle type.
 */
export function modeForAgency(step: Pick<TransitStep, 'agency' | 'mode'> & StepLine): TransitStep['mode'] {
  const name = step.agency.name;
  if (isPath(name) && (step.mode === 'rail' || step.mode === 'other')) return 'subway';
  return step.mode;
}

/**
 * The Pathly agencies whose timetable a Google transit step may run on, most likely first. A city
 * bus could be in any of the borough feeds (a route can cross boroughs), so all of them are tried.
 */
export function agencyIdsForStep(step: Pick<TransitStep, 'agency' | 'mode'> & StepLine): AgencyId[] {
  const name = step.agency.name;
  if (name === LIRR_AGENCY) return ['lirr'];
  if (isMetroNorth(name)) return ['metronorth'];
  if (isPath(name)) return ['path'];
  // The Staten Island Railway comes as an NYCT rail line; its timetable is the subway feed's SI.
  if (name === NYCT_AGENCY && (step.mode === 'subway' || step.mode === 'rail')) return ['subway'];
  if (((name === NYCT_AGENCY || name === MTA_AGENCY) && step.mode === 'bus') || isMtaBusCompany(name)) return [...MTA_BUS_AGENCY_IDS];
  if (name === NICE_AGENCY) return ['nice'];
  if (isSuffolk(name)) return ['suffolk'];
  if (isNycFerry(name)) return ['nycferry'];
  // Any other ferry: NYC Ferry, or NYC DOT's Staten Island Ferry.
  if (step.mode === 'ferry') return ['nycferry', 'siferry'];
  return [];
}
