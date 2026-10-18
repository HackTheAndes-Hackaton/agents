import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareVoiceSample } from '../speaker-samples.mjs';
// Vectores ficticios solo para probar el contrato; no son embeddings calculados.
const fixture = () => ({ incidentId: 'inc_test', sessionId: '00000000-0000-0000-0000-000000000001',
  consent: { voice_storage: true, voice_comparison: true }, sample: {
    model_id: 'speechbrain/spkrec-ecapa-voxceleb', model_version: '0f99f2d0ebe89ac095bcc5903c4dd8f72b367286:sb1.1.2:pcm16-v1',
    channel: 'caller_only', single_speaker_reviewed: true, embedding: Array(192).fill(.01),
    quality: { duration_s: 8, energy_active_s: 6, clipped_fraction: 0 } } });
test('no registra una referencia aprobada ni autoriza bloquear aunque el productor lo solicite', () => {
  const input = fixture(); input.sample.reference_enabled = true; input.sample.identity_verified = true;
  const out = prepareVoiceSample(input);
  assert.equal(out.reference_enabled, false); assert.equal(out.review_status, 'pendiente');
  assert.equal(out.quality_status, 'pending'); assert.equal(out.profile_id, null);
  assert.equal('identity_verified' in out, false);
});
test('rechaza falta de permisos, mezcla, muestra corta, modelo incompatible o números inválidos', () => {
  for (const mutate of [x => x.consent.voice_storage = false, x => x.consent.voice_comparison = false,
    x => x.sample.channel = 'provider_mixed', x => x.sample.single_speaker_reviewed = false,
    x => x.sample.quality.energy_active_s = 1, x => x.sample.model_version = 'otra',
    x => x.sample.embedding[0] = NaN, x => x.sample.embedding.fill(0), x => x.sample.embedding.pop()]) {
    const input = fixture(); mutate(input); assert.throws(() => prepareVoiceSample(input));
  }
});
