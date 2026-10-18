// This module measures received PCM, not device playback or telephone setup.
export function audiblePcm16(buffer, threshold = 150) {
  if (buffer.length < 2 || buffer.length % 2) return false;
  let energy = 0;
  for (let i = 0; i < buffer.length; i += 2) energy += buffer.readInt16LE(i) ** 2;
  return Math.sqrt(energy / (buffer.length / 2)) >= threshold;
}

export function latencyOutcome(endOfSpeech, firstReplyAudio, targetMs = 1500) {
  if (!Number.isFinite(endOfSpeech) || !Number.isFinite(firstReplyAudio)) {
    return {reply_audio_ms: null, target_met: false, interrupted_input: false};
  }
  const delta = firstReplyAudio - endOfSpeech;
  return {
    reply_audio_ms: Math.round(delta),
    target_met: delta >= 0 && delta < targetMs,
    interrupted_input: delta < 0,
  };
}

export function latencySummary(turns, targetMs = 1500) {
  const values = turns.map(t => t.reply_audio_ms).filter(v => Number.isFinite(v) && v >= 0).sort((a,b) => a-b);
  const percentile = p => values.length ? values[Math.ceil(p * values.length) - 1] : null;
  return {
    turns: turns.length, measured: values.length,
    target_ms: targetMs, target_met: turns.filter(t => t.completed !== false && Number.isFinite(t.reply_audio_ms) && t.reply_audio_ms >= 0 && t.reply_audio_ms < targetMs).length,
    median_ms: percentile(.5), p95_ms: percentile(.95),
    all_within_target: turns.length > 0 && turns.every(t => t.completed !== false && Number.isFinite(t.reply_audio_ms) && t.reply_audio_ms >= 0 && t.reply_audio_ms < targetMs),
    missing_or_interrupted: turns.length - values.length,
  };
}
