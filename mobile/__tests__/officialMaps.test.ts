import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

import { isMapSaved, OFFICIAL_MAPS, removeSavedMap, saveMap } from '../src/data/officialMaps';

jest.mock('expo-file-system', () => {
  const files = new Map<string, string>();
  class Directory {
    uri: string;
    constructor(parent: string, name: string) { this.uri = `${parent}/${name}/`; }
    get exists() { return true; }
    create() {}
    list() { return [...files.keys()].filter((uri) => uri.startsWith(this.uri)).map((uri) => new File(uri)); }
  }
  class File {
    uri: string;
    constructor(parent: Directory | string, name?: string) { this.uri = name ? `${typeof parent === 'string' ? parent : parent.uri.replace(/\/$/, '')}/${name}` : parent as string; }
    get exists() { return files.has(this.uri); }
    get size() { return files.get(this.uri)?.length ?? 0; }
    delete() { files.delete(this.uri); }
    open() {
      const text = files.get(this.uri) ?? '';
      return { offset: 0, readBytesSync(length: number) { const read = text.slice(this.offset, this.offset + length); this.offset += read.length; return Uint8Array.from(read, (c) => c.charCodeAt(0)); }, close() {} };
    }
    async move(destination: File) { files.set(destination.uri, files.get(this.uri)!); files.delete(this.uri); this.uri = destination.uri; }
    static downloadFileAsync = jest.fn(async (_url: string, destination: File) => { files.set(destination.uri, '%PDF-1.7\n' + 'Valid map contents '.repeat(4) + '\n%%EOF\n'); return destination; });
  }
  return { Directory, File, Paths: { document: 'fixture://documents' }, __files: files };
});

const files = (FileSystem as unknown as { __files: Map<string, string> }).__files;
const download = FileSystem.File.downloadFileAsync as jest.Mock;
const map = OFFICIAL_MAPS[0]!;
const pdf = '%PDF-1.7\n' + 'Valid map contents '.repeat(4) + '\n%%EOF\n';
const legacy = `fixture://documents/official-maps/${map.id}.pdf`;

beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'android');
  files.clear();
  download.mockClear();
});
afterEach(() => jest.restoreAllMocks());

it('does not publish or retain partial bytes after a rejected Android download', async () => {
  download.mockImplementationOnce(async (_url, destination) => { files.set(destination.uri, '%PDF-partial'); throw new Error('offline'); });
  await expect(saveMap(map)).rejects.toThrow('offline');
  expect(isMapSaved(map)).toBe(false);
  expect(files.size).toBe(0);
});

it.each(['<html>error page</html>'.repeat(3), '%PDF-1.7\n' + 'Truncated'.repeat(8)])('rejects an invalid or unfinished PDF: %s', async (body) => {
  download.mockImplementationOnce(async (_url, destination) => { files.set(destination.uri, body); return destination; });
  await expect(saveMap(map)).rejects.toThrow('invalid-pdf');
  expect(isMapSaved(map)).toBe(false);
  expect(files.size).toBe(0);
});

it('validates old saved files and preserves a good copy when a refresh fails', async () => {
  files.set(legacy, '%PDF-partial');
  expect(isMapSaved(map)).toBe(false);
  files.set(legacy, pdf);
  expect(isMapSaved(map)).toBe(true);
  download.mockRejectedValueOnce(new Error('offline'));
  await expect(saveMap(map)).rejects.toThrow('offline');
  expect(isMapSaved(map)).toBe(true);
  expect(files.get(legacy)).toBe(pdf);
});

it('coalesces concurrent requests and publishes only validated completed files', async () => {
  let complete!: () => void;
  download.mockImplementationOnce(async (_url, destination) => { await new Promise<void>((resolve) => { complete = resolve; }); files.set(destination.uri, pdf); return destination; });
  const first = saveMap(map);
  const second = saveMap(map);
  expect(first).toBe(second);
  expect(download).toHaveBeenCalledTimes(1);
  expect(isMapSaved(map)).toBe(false);
  complete();
  await first;
  expect(isMapSaved(map)).toBe(true);
  expect([...files.keys()]).toHaveLength(1);
  expect([...files.keys()][0]).toMatch(/\.complete-.*\.pdf$/);
});

it('does not resurrect a map removed while its download is in flight', async () => {
  let complete!: () => void;
  download.mockImplementationOnce(async (_url, destination) => { await new Promise<void>((resolve) => { complete = resolve; }); files.set(destination.uri, pdf); return destination; });
  const pending = saveMap(map);
  removeSavedMap(map);
  complete();
  await expect(pending).rejects.toThrow('download-cancelled');
  expect(isMapSaved(map)).toBe(false);
  expect(files.size).toBe(0);
});

it('a successful replacement keeps its completed file despite native move mutating its URI', async () => {
  files.set(legacy, pdf);
  await saveMap(map);
  expect(isMapSaved(map)).toBe(true);
  expect(files.has(legacy)).toBe(false);
  expect(files.size).toBe(1);
});

it('a publication failure preserves the previous PDF and cleans the new partial file', async () => {
  files.set(legacy, pdf);
  const prototype = FileSystem.File.prototype as unknown as { move(destination: unknown): Promise<void> };
  jest.spyOn(prototype, 'move').mockRejectedValueOnce(new Error('disk-full'));
  await expect(saveMap(map)).rejects.toThrow('disk-full');
  expect(isMapSaved(map)).toBe(true);
  expect(files.get(legacy)).toBe(pdf);
  expect([...files.keys()]).toEqual([legacy]);
});

it('cleans its own crash leftovers without touching another map download', async () => {
  files.set('fixture://documents/official-maps/subway.complete-old.pdf.part', '%PDF-partial');
  const unrelated = 'fixture://documents/official-maps/lirr.complete-active.pdf.part';
  files.set(unrelated, '%PDF-in-progress');
  await saveMap(map);
  expect(files.has('fixture://documents/official-maps/subway.complete-old.pdf.part')).toBe(false);
  expect(files.has(unrelated)).toBe(true);
  expect(isMapSaved(map)).toBe(true);
});
