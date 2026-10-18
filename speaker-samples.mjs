const MODEL = 'speechbrain/spkrec-ecapa-voxceleb';
const VERSION = '0f99f2d0ebe89ac095bcc5903c4dd8f72b367286:sb1.1.2:pcm16-v1';

// Prepara el contrato ya existente de /api/v1/voice-samples. No realiza escrituras.
export function prepareVoiceSample({ sample, incidentId, sessionId, consent }) {
  if (consent?.voice_storage !== true || consent?.voice_comparison !== true) throw Error('Se requieren permisos de conservación y comparación vocal.');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(incidentId ?? '') || !/^[a-f0-9-]{36}$/i.test(sessionId ?? '')) throw Error('Incidente o sesión inválidos.');
  if (sample?.model_id !== MODEL || sample?.model_version !== VERSION) throw Error('Modelo o preprocesamiento incompatibles.');
  if (sample.channel !== 'caller_only' || sample.single_speaker_reviewed !== true) throw Error('La mezcla de conferencia no es una referencia de hablante.');
  const vector = sample.embedding;
  if (!Array.isArray(vector) || vector.length !== 192 || vector.some(x => typeof x !== 'number' || !Number.isFinite(x)) || !vector.some(x => x !== 0)) throw Error('Embedding inválido.');
  const q = sample.quality;
  if (!Number.isFinite(q?.duration_s) || q.duration_s < 3 || q.duration_s > 15 || !Number.isFinite(q.energy_active_s) || q.energy_active_s < 3 || q.energy_active_s > q.duration_s + .02 || !Number.isFinite(q.clipped_fraction) || q.clipped_fraction < 0 || q.clipped_fraction > .01) throw Error('Calidad insuficiente.');
  return { incident_id: incidentId, source_session_ref: sessionId, embedding: [...vector],
    model_id: MODEL, model_version: VERSION, duration_s: q.duration_s,
    speaker: 'caller', quality_status: 'pending', review_status: 'pendiente', reference_enabled: false, profile_id: null };
}
