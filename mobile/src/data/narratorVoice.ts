import * as Speech from 'expo-speech';

type VoiceInfo = { identifier: string; language: string; quality?: string; name?: string };

/**
 * The best-sounding English voice the phone has, for spoken trip directions. The default voice is
 * often the oldest one; phones usually also carry "Enhanced" voices (and, on Android, Google's
 * neural ones), which sound far less robotic. Prefers US English, then any English; among those,
 * Enhanced quality, then a voice that doesn't need the network (it's read underground).
 */
export function pickNarratorVoice(voices: readonly VoiceInfo[]): string | null {
  const english = voices.filter((voice) => /^en([-_]|$)/i.test(voice.language));
  if (english.length === 0) return null;
  const score = (voice: VoiceInfo) => {
    const name = `${voice.identifier} ${voice.name ?? ''}`.toLowerCase();
    let points = 0;
    if (/^en[-_]us$/i.test(voice.language)) points += 8;
    if (voice.quality === 'Enhanced') points += 4;
    if (name.includes('network')) points -= 3;
    if (name.includes('compact') || name.includes('eloquence')) points -= 2;
    return points;
  };
  return [...english].sort((a, b) => score(b) - score(a))[0]!.identifier;
}

let chosen: string | null | undefined;
let lookup: Promise<void> | null = null;

/** Looks up the phone's voices once, so the first direction isn't held up waiting for it. */
export function prepareNarratorVoice(): void {
  if (lookup || typeof Speech.getAvailableVoicesAsync !== 'function') return;
  lookup = Speech.getAvailableVoicesAsync()
    .then((voices) => {
      chosen = pickNarratorVoice(voices);
    })
    .catch(() => {
      chosen = null;
    });
}

/** The voice picked by prepareNarratorVoice, or undefined until it's known (the phone's default is used). */
export function narratorVoice(): string | undefined {
  return chosen ?? undefined;
}

/** Test isolation only. */
export function resetNarratorVoiceForTests(): void {
  chosen = undefined;
  lookup = null;
}
