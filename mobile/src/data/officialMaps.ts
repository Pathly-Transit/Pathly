import { Directory, File, Paths } from 'expo-file-system';
import { getContentUriAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

/**
 * The MTA's own maps (PDFs from mta.info/maps), for riders who lose signal underground or run out
 * of data. The MTA permits personal, non-commercial use; each is saved only on the rider's device.
 */
export type OfficialMap = { id: string; title: string; detail: string; url: string; group: 'Subway' | 'Railroads' | 'Bus' };

export const OFFICIAL_MAPS: readonly OfficialMap[] = [
  { id: 'subway', title: 'Subway map', detail: 'The classic diagram', url: 'https://www.mta.info/map/5256', group: 'Subway' },
  { id: 'subway-geographic', title: 'Geographic subway map', detail: 'Lines drawn over the streets', url: 'https://www.mta.info/map/36946', group: 'Subway' },
  { id: 'subway-accessible', title: 'Accessible stations map', detail: 'Step-free stations marked', url: 'https://www.mta.info/map/5346', group: 'Subway' },
  { id: 'lirr', title: 'LIRR map', detail: 'Every branch and station', url: 'https://www.mta.info/map/42901', group: 'Railroads' },
  { id: 'railroads', title: 'MTA railroads diagram', detail: 'LIRR and Metro-North together', url: 'https://www.mta.info/map/22461', group: 'Railroads' },
  { id: 'bus-bronx', title: 'Bronx bus map', detail: 'Local and Select Bus routes', url: 'https://www.mta.info/map/5366', group: 'Bus' },
  { id: 'bus-brooklyn', title: 'Brooklyn bus map', detail: 'Local and Select Bus routes', url: 'https://www.mta.info/map/5261', group: 'Bus' },
  { id: 'bus-manhattan', title: 'Manhattan bus map', detail: 'Local and Select Bus routes', url: 'https://www.mta.info/map/5391', group: 'Bus' },
  { id: 'bus-queens', title: 'Queens bus map', detail: 'Local routes (a large file)', url: 'https://www.mta.info/map/5371', group: 'Bus' },
  { id: 'bus-queens-express', title: 'Queens express bus map', detail: 'Express routes to Manhattan', url: 'https://www.mta.info/map/40256', group: 'Bus' },
  { id: 'bus-staten-island', title: 'Staten Island bus map', detail: 'Local and Select Bus routes', url: 'https://www.mta.info/map/5376', group: 'Bus' },
  { id: 'bus-staten-island-express', title: 'Staten Island express bus map', detail: 'Express routes to Manhattan', url: 'https://www.mta.info/map/5381', group: 'Bus' },
];

/** Saving needs a file system: the native apps. On the web a map opens in the browser instead. */
export const CAN_SAVE_MAPS = Platform.OS !== 'web';

/**
 * The members used here of expo-file-system's File and Directory. tsconfig's moduleSuffixes reach
 * the module's `.web` typings first, which leave them out, so they're named here.
 */
type Entry = {
  readonly uri: string; readonly exists: boolean; readonly size: number;
  delete(): void; create(options?: { intermediates?: boolean; idempotent?: boolean }): void;
  list(): (File | Directory)[];
  move(destination: File): Promise<void>;
  open(mode: string): { offset: number; readBytesSync(length: number): Uint8Array; close(): void };
};

function mapsDirectory(): Directory {
  return new Directory(Paths.document, 'official-maps');
}

function mapFile(map: OfficialMap): File {
  return new File(mapsDirectory(), `${map.id}.pdf`);
}

const entry = (item: File | Directory) => item as unknown as Entry;
const saves = new Map<string, Promise<void>>();
const versions = new Map<string, number>();
let downloadSequence = 0;

function completedFiles(map: OfficialMap): File[] {
  const directory = entry(mapsDirectory());
  if (!directory.exists) return [];
  const prefix = `${directory.uri.replace(/\/+$/, '')}/${map.id}.complete-`;
  return directory.list().filter((file): file is File => entry(file).uri.startsWith(prefix) && entry(file).uri.endsWith('.pdf'))
    .sort((a, b) => entry(b).uri.localeCompare(entry(a).uri));
}

/** Bounded reads reject HTML and truncated PDFs without loading a large borough map into JS. */
function isCompletePdf(file: File): boolean {
  const info = entry(file);
  if (!info.exists || info.size < 32) return false;
  const handle = info.open('r');
  const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);
  try {
    if (!ascii(handle.readBytesSync(8)).startsWith('%PDF-')) return false;
    handle.offset = Math.max(0, info.size - 1024);
    return /%%EOF\s*$/.test(ascii(handle.readBytesSync(1024)));
  } finally {
    handle.close();
  }
}

function savedMapFile(map: OfficialMap): File | undefined {
  // Legacy files are accepted only after validation; a pre-upgrade partial file is not saved.
  return [...completedFiles(map), mapFile(map)].find((file) => {
    try { return isCompletePdf(file); } catch { return false; }
  });
}

/** Whether a map is saved on this device. */
export function isMapSaved(map: OfficialMap): boolean {
  if (!CAN_SAVE_MAPS) return false;
  try {
    return savedMapFile(map) != null;
  } catch {
    return false;
  }
}

/** Downloads a map to the device (replacing an older copy), for opening with no signal. */
export function saveMap(map: OfficialMap): Promise<void> {
  const pending = saves.get(map.id);
  if (pending) return pending;
  const version = versions.get(map.id) ?? 0;
  const name = `${map.id}.complete-${Date.now()}-${String(++downloadSequence).padStart(6, '0')}.pdf`;
  const temporary = new File(mapsDirectory(), `${name}.part`);
  const work = (async () => {
    const directory = entry(mapsDirectory());
    if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
    const partialPrefix = `${directory.uri.replace(/\/+$/, '')}/${map.id}.complete-`;
    for (const stale of directory.list()) {
      const old = entry(stale);
      // One coalesced save per map owns these files; other maps' downloads are left alone.
      if (old.uri.startsWith(partialPrefix) && old.uri.endsWith('.pdf.part')) {
        try { old.delete(); } catch { /* Never treat leftover partial data as a saved map. */ }
      }
    }
    try {
      await File.downloadFileAsync(map.url, temporary, { idempotent: true });
      if (!isCompletePdf(temporary)) throw new Error('invalid-pdf');
      if ((versions.get(map.id) ?? 0) !== version) throw new Error('download-cancelled');
      // Publish a new immutable completed name: a failed move never replaces the valid old PDF.
      const completed = new File(mapsDirectory(), name);
      await entry(temporary).move(completed);
      if ((versions.get(map.id) ?? 0) !== version) {
        if (entry(completed).exists) entry(completed).delete();
        throw new Error('download-cancelled');
      }
      for (const old of [...completedFiles(map), mapFile(map)]) {
        if (entry(old).uri !== entry(completed).uri && entry(old).exists) {
          try { entry(old).delete(); } catch { /* A leftover valid version is harmless. */ }
        }
      }
    } finally {
      // move() mutates the File object's URI, so cleanup must refer to the original .part path.
      const partial = entry(new File(mapsDirectory(), `${name}.part`));
      if (partial.exists) partial.delete();
    }
  })();
  saves.set(map.id, work);
  void work.finally(() => { if (saves.get(map.id) === work) saves.delete(map.id); }).catch(() => undefined);
  return work;
}

export function removeSavedMap(map: OfficialMap): void {
  versions.set(map.id, (versions.get(map.id) ?? 0) + 1);
  for (const file of [...completedFiles(map), mapFile(map)]) if (entry(file).exists) entry(file).delete();
}

/** Android's FLAG_GRANT_READ_URI_PERMISSION: lets the PDF viewer read the saved file. */
const GRANT_READ_URI_PERMISSION = 1;

/**
 * Opens a map: the saved copy when there is one (works offline), else the MTA's own copy in the
 * browser. On Android the saved copy opens straight in the phone's PDF viewer; the share sheet
 * only comes up when no app can open a PDF. On iOS the system preview opens it.
 */
export async function openMap(map: OfficialMap): Promise<void> {
  const saved = CAN_SAVE_MAPS ? savedMapFile(map) : undefined;
  if (Platform.OS === 'android' && saved) {
    try {
      const uri = await getContentUriAsync(entry(saved).uri);
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data: uri, type: 'application/pdf', flags: GRANT_READ_URI_PERMISSION });
      return;
    } catch {
      // No PDF viewer on the phone: fall through to the share sheet, which can still open it.
    }
  }
  if (saved && (await Sharing.isAvailableAsync())) {
    await Sharing.shareAsync(entry(saved).uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: map.title });
    return;
  }
  await WebBrowser.openBrowserAsync(map.url);
}
