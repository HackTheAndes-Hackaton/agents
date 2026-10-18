import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneAudioWindow } from '../phone-evidence.mjs';
const tone = (rate, seconds, hz = 1000) => {
  const pcm = Buffer.alloc(rate * seconds * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * hz * i / rate)), i * 2);
  return pcm;
};
test('ventana acotada a 10 s, WAV mono 16 kHz y borrado al cerrar', () => {
  const b = new PhoneAudioWindow(); b.push(tone(24000, .5), 24000); assert.equal(b.wav(), null);
  b.push(tone(24000, 12), 24000); assert.equal(b.bytes, 480000);
  const wav = b.wav(); assert.equal(wav.length, 320044); assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  const held = b.chunks[0]; b.clear(); assert.ok(held.every(x => x === 0)); assert.equal(b.wav(), null);
});
test('resample reduce alias fuera de banda y rechaza formatos inesperados', () => {
  const rms = hz => {
    const b = new PhoneAudioWindow(); b.push(tone(24000, 1, hz), 24000); const wav = b.wav();
    let energy = 0; for (let i = 400; i < 15600; i++) energy += wav.readInt16LE(44 + i * 2) ** 2;
    return Math.sqrt(energy / 15200);
  };
  assert.ok(rms(10000) < rms(1000) * .05);
  const b = new PhoneAudioWindow(); b.push(Buffer.alloc(4), 44100); assert.equal(b.bytes, 0);
});
