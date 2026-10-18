import {Conversation} from '@elevenlabs/client';
const $=id=>document.getElementById(id);
let session,timer,lastSpeech,pendingTurn=false,agentSpeaking=false;
function row(who,text){const p=document.createElement('p');const b=document.createElement('strong');b.textContent=who+': ';p.append(b,document.createTextNode(text));$('transcript').append(p);}
function reset(){clearTimeout(timer);session=undefined;pendingTurn=false;lastSpeech=undefined;$('start').disabled=false;$('stop').disabled=true;}
function firstResponse(){
  if(!pendingTurn||!Number.isFinite(lastSpeech))return;
  const elapsed=performance.now()-lastSpeech;pendingTurn=false;
  $('latency').textContent=`${Math.round(elapsed)} ms estimados · ${elapsed<1500?'dentro del objetivo':'fuera del objetivo'}`;
}
$('start').onclick=async()=>{
  $('start').disabled=true;$('status').textContent='Conectando…';
  try{
    const r=await fetch('/api/session',{method:'POST',headers:{'X-Tiskz-Trial':document.querySelector('meta[name="trial"]').content}});
    if(!r.ok)throw Error('session');
    const {token}=await r.json();
    session=await Conversation.startSession({
      conversationToken:token,connectionType:'webrtc',
      onConnect:()=>{$('status').textContent='Conectado. Puedes hablar después del saludo.';},
      onMessage:m=>{if(m.message)row(m.source==='user'||m.role==='user'?'Tú':'Agente',m.message);},
      onVadScore:({vadScore})=>{if(vadScore>.65&&!agentSpeaking){lastSpeech=performance.now();pendingTurn=true;}},
      onAudio:()=>firstResponse(),
      onModeChange:({mode})=>{agentSpeaking=mode==='speaking';$('status').textContent=agentSpeaking?'El agente está hablando':'El agente está escuchando';},
      onDisconnect:()=>{$('status').textContent='Prueba finalizada';reset();},
      onError:()=>{$('status').textContent='No se pudo mantener la conexión. Finaliza y vuelve a iniciar.';},
    });
    $('stop').disabled=false;
    timer=setTimeout(async()=>{await session?.endSession();reset();},110000);
  }catch{$('status').textContent='No se pudo iniciar. Revisa el permiso de micrófono y vuelve a intentarlo.';reset();}
};
$('stop').onclick=async()=>{await session?.endSession();$('status').textContent='Prueba finalizada';reset();};
window.addEventListener('pagehide',()=>{session?.endSession();});
