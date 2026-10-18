import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {build} from 'esbuild';
const exec=promisify(execFile),args=process.argv.slice(2);
const arg=(n,f)=>{const i=args.indexOf(n);return i<0?f:args[i+1];};
const agent=arg('--agent');
if(!agent||!/^agent_[a-zA-Z0-9]+$/.test(agent))throw Error('Usa --agent agent_ID');
const sdkDir=resolve(arg('--sdk-dir','.maritime/cascade-trial/client'));
const sdk=createRequire(sdkDir+'/package.json').resolve('@elevenlabs/client');
const bundle=await build({entryPoints:[new URL('./cascada-voz-browser.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',alias:{'@elevenlabs/client':sdk}});
const csrf=randomBytes(24).toString('hex');
let origin,minting=false,minted=0;
const html=`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="trial" content="${csrf}"><title>Tiskz · Cascada de voz</title><style>body{font:17px system-ui;background:#101b21;color:#e4f1ed;max-width:760px;margin:36px auto;padding:24px}h1{font-size:30px}button{font:inherit;padding:14px 24px;border:0;border-radius:10px;margin:8px 12px 8px 0;background:#69e0aa;color:#092e20;cursor:pointer}button:disabled{opacity:.4}p{line-height:1.6}.note{color:#b1c7c1}#transcript{border-top:1px solid #38554a;margin-top:24px}#latency{font-size:22px}</style><h1>Tiskz · Cascada de voz</h1><p>Transcripción continua → modelo de texto → voz Sarah de ElevenLabs.</p><p class="note">Al iniciar, enviarás el micrófono a ElevenLabs. Grabación desactivada y eliminación programada del historial. Usa casos ficticios. Esta prueba local todavía no conecta el número de Vapi, las alertas ni el corte de la APK.</p><button id="start">Iniciar conversación</button><button id="stop" disabled>Finalizar</button><p id="status" role="status">Listo para probar</p><p id="latency">Objetivo: primer audio antes de 1,50 segundos</p><p class="note">El indicador del navegador es aproximado: usa los eventos de actividad de voz recibidos. Las mediciones controladas se hacen con audio sintético; no son una garantía de latencia telefónica.</p><p>Prueba: «Quiero coordinar una reunión mañana. No necesito pagos ni códigos»; después corrige una cantidad.</p><div id="transcript" aria-live="polite"></div><script type="module" src="/client.js"></script></html>`;
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
  const json=(s,b)=>{res.writeHead(s,{'Content-Type':'application/json'});res.end(JSON.stringify(b));};
  if(req.headers.host!==new URL(origin).host)return json(403,{error:'forbidden'});
  if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});return res.end(html);}
  if(req.method==='GET'&&req.url==='/health')return json(200,{ready:true,agent_id:agent,apk_alerts_connected:false,pstn_tested:false});
  if(req.method==='GET'&&req.url==='/client.js'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(bundle.outputFiles[0].contents);}
  if(req.method==='POST'&&req.url==='/api/session'){
    if(req.headers.origin!==origin||req.headers['x-tiskz-trial']!==csrf)return json(403,{error:'forbidden'});
    if(minting||minted>=3)return json(429,{error:'trial_limit'});
    minting=true;
    try{
      const r=await exec('elevenlabs',['agents','conversations','get_webrtc_token','--agent-id',agent],{timeout:20000,maxBuffer:1024*1024});
      const s=JSON.parse(r.stdout);if(!s.token)throw Error('no_token');
      minted++;return json(200,{token:s.token});
    }catch{return json(502,{error:'session_unavailable'});}
    finally{minting=false;}
  }
  return json(404,{error:'not_found'});
});
server.listen(0,'127.0.0.1',()=>{origin=`http://127.0.0.1:${server.address().port}`;console.log(JSON.stringify({url:origin,agent_id:agent}));});
