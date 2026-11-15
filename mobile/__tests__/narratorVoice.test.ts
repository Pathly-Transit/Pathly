import { pickNarratorVoice } from '../src/data/narratorVoice';

describe('pickNarratorVoice', () => {
  it('prefers an Enhanced US English voice that works offline', () => {
    expect(pickNarratorVoice([
      { identifier: 'fr-fr-x-vlf-local', language: 'fr-FR', quality: 'Enhanced' },
      { identifier: 'en-us-x-sfg-network', language: 'en-US', quality: 'Enhanced' },
      { identifier: 'en-us-x-iol-local', language: 'en-US', quality: 'Enhanced' },
      { identifier: 'en-us-default', language: 'en-US', quality: 'Default' },
      { identifier: 'en-gb-x-rjs-local', language: 'en-GB', quality: 'Enhanced' },
    ])).toBe('en-us-x-iol-local');
  });

  it('falls back to any English voice, and to none without one', () => {
    expect(pickNarratorVoice([{ identifier: 'en-gb-1', language: 'en_GB' }, { identifier: 'es-1', language: 'es-US', quality: 'Enhanced' }])).toBe('en-gb-1');
    expect(pickNarratorVoice([{ identifier: 'es-1', language: 'es-US' }])).toBeNull();
    expect(pickNarratorVoice([])).toBeNull();
  });
});
