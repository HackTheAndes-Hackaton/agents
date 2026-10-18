import {test} from 'node:test';
import assert from 'node:assert/strict';
import {audiblePcm16, latencyOutcome, latencySummary} from '../voice-trial-metrics.mjs';

test('silence and a malformed PCM fragment do not start the response clock', () => {
  assert.equal(audiblePcm16(Buffer.alloc(640)), false);
  assert.equal(audiblePcm16(Buffer.alloc(1)), false);
  const voice = Buffer.alloc(640);
  for (let i=0;i<voice.length;i+=2) voice.writeInt16LE(i%4 ? -1200 : 1200,i);
  assert.equal(audiblePcm16(voice), true);
});

test('missing and premature replies cannot satisfy the strict 1.5-second objective', () => {
  assert.equal(latencyOutcome(1000, undefined).target_met, false);
  assert.deepEqual(latencyOutcome(1000,900), {reply_audio_ms:-100,target_met:false,interrupted_input:true});
  assert.equal(latencyOutcome(1000,2499).target_met,true);
  assert.equal(latencyOutcome(1000,2500).target_met,false);
  assert.equal(latencyOutcome(1000,2501).target_met,false);
});

test('summary retains failed turns instead of reporting a successful-only SLA', () => {
  const summary=latencySummary([latencyOutcome(100,600),latencyOutcome(100,1800),latencyOutcome(100,undefined)]);
  assert.equal(summary.turns,3);
  assert.equal(summary.measured,2);
  assert.equal(summary.target_met,1);
  assert.equal(summary.p95_ms,1700);
  assert.equal(summary.all_within_target,false);
  assert.equal(latencySummary([]).all_within_target,false);
  assert.equal(latencySummary([{reply_audio_ms:500,target_met:true,completed:false}]).all_within_target,false);
});
