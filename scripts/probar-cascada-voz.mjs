// Real provider calls, fictitious speech only. No microphone or telephone capture.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import WebSocket from 'ws';
import {audiblePcm16,latencyOutcome,latencySummary} from '../voice-trial-metrics.mjs';
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const args=process.argv.slice(2);
const arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const agent=arg('--agent');
if(!agent || !/^agent_[a-zA-Z0-9]+$/.test(agent)) throw Error('Usa --agent agent_ID');
const out=resolve(arg('--out','.maritime/cascade-trial'));
// Evidence from this command is always private, never an arbitrary Git path.
const privateRoot=resolve('.maritime')+'/';
if(!out.startsWith(privateRoot)) throw Error('--out debe estar dentro de .maritime/ (ignorado por Git).');
const fixture=JSON.parse(await readFile(new URL('../eval/cascada-voz-sintetica-v1.json',import.meta.url),'utf8'));
const count=Number(arg('--limit',fixture.cases.length));
if(!Number.isInteger(count)||count<1||count>fixture.cases.length)throw Error('Límite de casos inválido.');
await mkdir(out,{recursive:true,mode:0o700});
const scratch=await mkdtemp(join(tmpdir(),'tiskz-cascade-'));

async function sample(item){
  const aiff=join(scratch,item.id+'.aiff'),pcmFile=join(scratch,item.id+'.pcm');
  await exec('say',['-v','Paulina','-r','175','-o',aiff,item.text]);
  await exec('ffmpeg',['-v','error','-i',aiff,'-f','s16le','-ar','16000','-ac','1',pcmFile],{timeout:15000});
  const pcm=await readFile(pcmFile);
  let first=0,last=pcm.length;
  while(first<last&&!audiblePcm16(pcm.subarray(first,Math.min(first+640,last))))first+=640;
  while(last>first&&!audiblePcm16(pcm.subarray(Math.max(first,last-640),last)))last-=640;
  if(first>=last)throw Error('Muestra sintética silenciosa');
  return pcm.subarray(Math.max(0,first-640),last);
}

async function probe(item,pcm){
  const signed=JSON.parse((await exec('elevenlabs',['agents','conversations','get_signed_url','--agent-id',agent],{timeout:20000})).stdout);
  if(!signed.signed_url)throw Error('No hay sesión firmada');
  const start=performance.now(),now=()=>performance.now()-start;
  const ws=new WebSocket(signed.signed_url);
  const captions=[],responses=[],events=[],providerMetrics=[];
  let conversationId,formatOK=false,error,closed=false,firstAudio,lastAudio=-Infinity,playbackEnd=0;
  let inputStart,inputEnd,firstReply,captionAt;
  ws.on('open',()=>ws.send(JSON.stringify({type:'conversation_initiation_client_data'})));
  ws.on('error',()=>{error='websocket_error';});
  ws.on('close',code=>{closed=true;events.push({type:'close',code,at_ms:Math.round(now())});});
  ws.on('message',raw=>{
    let e;try{e=JSON.parse(raw);}catch{return;}
    if(e.type==='ping'){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'pong',event_id:e.ping_event.event_id}));return;}
    const at=now();
    if(e.type==='conversation_initiation_metadata'){
      const m=e.conversation_initiation_metadata_event;conversationId=m.conversation_id;
      formatOK=m.user_input_audio_format==='pcm_16000'&&m.agent_output_audio_format==='pcm_16000';
      if(!formatOK)error='unexpected_pcm_format';
    }
    if(e.type==='audio'){
      const b=Buffer.from(e.audio_event.audio_base_64,'base64');
      playbackEnd=Math.max(playbackEnd,at)+b.length/32;lastAudio=at;
      if(audiblePcm16(b)){
        firstAudio??=at;
        if(inputStart!==undefined)firstReply??=at;
      }
    }else if(e.type==='user_transcript'){
      captionAt??=at;captions.push({at_ms:Math.round(at),...e.user_transcription_event});
    }else if(e.type==='agent_response'){
      responses.push({at_ms:Math.round(at),...e.agent_response_event});
    }else if(e.type==='agent_response_metadata'){
      providerMetrics.push({at_ms:Math.round(at),...e.agent_response_metadata_event});
    }else if(e.type==='client_error'||e.type==='error'){error='provider_error';}
    // Keep event timings, never tokens, signed URLs, raw errors, or PCM.
    if(e.type!=='audio')events.push({type:e.type,at_ms:Math.round(at)});
  });
  async function until(predicate,timeout){
    const deadline=now()+timeout;
    while(!predicate()){
      if(error||closed||now()>deadline)return false;
      await sleep(10);
    }
    return true;
  }
  let completed=false;
  try{
    if(!await until(()=>formatOK&&firstAudio!==undefined&&now()>playbackEnd+350&&now()-lastAudio>350,15000))throw Error(error||'greeting_timeout');
    inputStart=now();
    const frameCount=Math.ceil(pcm.length/640);
    for(let frame=0;frame<frameCount;frame++){
      if(error||closed)throw Error(error||'early_close');
      const offset=frame*640;
      await sleep(Math.max(0,inputStart+frame*20-now()));
      const b=pcm.subarray(offset,Math.min(offset+640,pcm.length));
      ws.send(JSON.stringify({user_audio_chunk:b.toString('base64')}));
    }
    inputEnd=inputStart+pcm.length/32;
    await sleep(Math.max(0,inputEnd-now()));
    // Silence stays paced while the provider closes the turn and streams speech.
    const silence=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({user_audio_chunk:Buffer.alloc(640).toString('base64')}));},20);
    try{
      completed=await until(()=>firstReply!==undefined&&captions.length&&responses.length>1&&now()>playbackEnd+400&&now()-lastAudio>400,15000);
      if(!completed)error??='reply_timeout';
    }finally{clearInterval(silence);}
  }catch(e){error=e.message;}
  finally{if(ws.readyState===WebSocket.OPEN)ws.close(1000);else if(ws.readyState===WebSocket.CONNECTING)ws.terminate();}
  await sleep(300);
  return {
    case_id:item.id,reference:item.text,conversation_id:conversationId,
    input:'synthetic_macos_paulina_pcm16_16000',transport:'signed_websocket',
    input_duration_ms:Math.round(pcm.length/32),greeting_ms:firstAudio===undefined?null:Math.round(firstAudio),
    ...latencyOutcome(inputEnd,firstReply),
    transcript_ms:captionAt===undefined||inputEnd===undefined?null:Math.round(captionAt-inputEnd),
    captions,responses,events,providerMetrics,completed:completed&&!error,error:error||null,
    measurement:'end_of_synthetic_speech_to_first_audible_pcm_arrival_not_device_playback',
    apk_alerts_connected:false,pstn_tested:false,
  };
}

const results=[];
try{
  for(const item of fixture.cases.slice(0,count)){
    const result=await probe(item,await sample(item));results.push(result);
    await writeFile(join(out,item.id+'.json'),JSON.stringify(result,null,2),{mode:0o600});
    console.log(JSON.stringify({case_id:item.id,...latencyOutcome(0,result.reply_audio_ms),transcript_ms:result.transcript_ms,greeting_ms:result.greeting_ms,error:result.error}));
    if(result.error)break;
  }
}finally{await rm(scratch,{recursive:true,force:true});}
const report={agent_id:agent,synthetic_only:true,summary:latencySummary(results),results};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify(report.summary));
if(results.some(r=>!r.completed))process.exitCode=1;
