# Canal de voz de Tiskz

`AGENT_ROLE=voz` ejecuta un servidor de señalización WebRTC, un canal WebSocket de eventos y los dos agentes lógicos en una sola VM de Maritime. Así no es necesario despertar simultáneamente las otras dos máquinas del plan gratuito. Las inferencias y la transcripción consumen créditos del proveedor; el alojamiento gratuito no implica audio ilimitado.

## Flujo

1. El navegador/intermediario obtiene un `MediaStream` autorizado: micrófono, archivo de prueba o pista recibida por otro WebRTC.
2. `POST /v1/sessions` con `X-Voice-Token: <VOICE_ACCESS_CODE>` y `{"consentimiento_analisis":true}` devuelve una sala, un ticket de productor y otro de observador. La sala dura hasta 15 minutos o 100 fragmentos, con dos sesiones simultáneas.
3. El productor conecta `/ws/calls?session=<id>&ticket=<producer_token>`.
4. Crea un `RTCPeerConnection`, añade la pista de audio y crea un DataChannel. Envía su oferta SDP a `POST /v1/sessions/<id>/offer`, autenticado con `X-Voice-Token: <producer_token>`. Recibe el SDP de respuesta.
5. La negociación y la credencial de Maritime permanecen en el servidor. Los paquetes de audio WebRTC viajan desde el cliente al proveedor OpenAI; la VM no retransmite ese audio. El modelo `gpt-live-transcribe` devuelve fragmentos por DataChannel. El cliente detecta pausas y realiza `input_audio_buffer.commit`.
6. El productor reenvía eventos `transcript.update` al servidor. Los finales disparan GPT Decisions (`gpt-6-luna`) y comprensión (`gpt-4.1-mini`) con el contexto acumulado. Los parciales solo se muestran. Las revisiones obsoletas y finales duplicados se descartan.
7. `alert.updated` contiene `alerta: true|false`, `probability`, `threshold`, `revision` y `provisional:true`. `understanding.update` usa `modo: "extractivo_sin_identidades_v1"`: solo citas literales de oraciones completas, tipos permitidos y descripciones redactadas por el servidor. Los campos narrativos libres del modelo se descartan; no se atribuyen identidades ni hablantes. Las citas recortadas que omiten una negación/contexto se rechazan. El eco `transcript.update` conserva `sequence` para que el móvil ordene por turno, aunque los finales lleguen invertidos. Un fallo del modelo produce `error`, nunca un FALSE de sustitución.
8. Terminar: `POST /v1/sessions/<id>/end` con `X-Voice-Token: <producer_token>`; el cliente cierra inmediatamente su conexión WebRTC y sus pistas. El servidor solicita además `/hangup` cuando el proxy conserva la cabecera `Location` del proveedor. Si esa cabecera no está disponible, el cierre de medios depende del `RTCPeerConnection` del productor. Desconectar al productor concede cinco segundos para reconectar y después termina la sesión.

El módulo `/voice-client.js` exporta `connectVoice({stream, accessCode, consentimiento:true, baseUrl, onEvent})`, que devuelve `{stop, peerConnection, sessionId}`. Es la integración mínima para un intermediario web propio. Sirve el cliente en el mismo origen; no se habilita CORS público. Para un intermediario de otro origen, utiliza su backend de confianza para crear y negociar la sesión o implementa una política explícita de orígenes permitidos. Nunca distribuyas la clave del proveedor ni el código maestro dentro de una app publicada: tu backend debe emitir tickets limitados por sesión.

## App Android existente

Repositorio inspeccionado: https://github.com/HackTheAndes-Hackaton/mobile-repo (Kotlin, Tiskz).

En Settings, desactiva Demo Mode y pega en WebSocket URL la URL de observador que muestra la página después de conectar el audio. Se puede mantener Backend URL en el origen HTTPS del servicio. El cliente ya acepta parámetros de consulta y añade `caller`; este número no autentica ni identifica al hablante.

Se emiten los formatos existentes `agent.status`, `transcript.update`, `risk.update`, `call.ended` y `error`. Los eventos nuevos son ignorados por el parser antiguo. El ticket de observador puede ver la sesión y enviar las decisiones de interfaz existentes. `reject`, `hang_up`, `block` y `answer` terminan **esta sesión de análisis**; no ejecutan acciones en la red telefónica ni registran números en una lista de bloqueo. `not_scam` solo comunica una corrección humana; no reentrena el modelo.

El campo antiguo `risk_percent` se utiliza por compatibilidad para mostrar la probabilidad de que corresponda emitir una alerta, **no una probabilidad validada de estafa**. Se acompaña de `score_kind` y una explicación en `reasons`. No se emiten coincidencias biométricas. En el canal telefónico, `call.ready_to_answer` solo se envía cuando ambos análisis completan la revisión actual con `observar` y alerta FALSE; permite incorporarse después de una revisión inicial y declara `identity_verified:false`. No autentica a quien llama ni garantiza que la llamada sea segura.

La app móvil dispone del canal nativo de micrófono; su integración anterior está en mobile-repo PR #1, ya fusionado. El modo de conversación con marin se entrega en una PR posterior. Tampoco existe captura universal de llamadas de operadora: para analizar llamadas reales se necesita una fuente de audio autorizada del proveedor de telefonía o de la sesión WebRTC propia.

## Datos y acceso

El servidor conserva texto solo en memoria durante la sesión y no escribe grabaciones ni transcripciones en disco. El proveedor de IA procesa el audio y el texto según su política de datos. El productor autenticado remite las transcripciones: esta arquitectura es apropiada para el intermediario del equipo, no ofrece evidencia forense de que cada texto provenga del audio. En producción, conecta una sesión lateral de servidor para verificar los eventos del proveedor.

El código privado se guarda localmente en `.maritime/voice-access.json`, excluido de Git y con permisos 0600. No pegues tickets de sesión en repositorios, informes públicos o capturas. Los tickets caducan con la sala. Al reiniciar/dormir la VM, las salas en memoria se pierden.

## Validación

`npm test` verifica consentimiento, aislamiento entre salas, roles del WebSocket, deduplicación, revisiones, fallos del modelo, negociación SDP y cierre del proveedor. Las pruebas unitarias utilizan proveedores simulados; la prueba de audio real del despliegue se registra por separado en `deploy/verificacion-voz.json`.

Referencia de transcripción: https://developers.openai.com/api/docs/guides/realtime-transcription
Referencia de WebRTC: https://developers.openai.com/api/docs/guides/voice-webrtc?api=realtime

## Arranque alternativo sin constructor remoto

Si el constructor de ZIP queda bloqueado, `node scripts/preparar-runtime.mjs` empaqueta únicamente el código del servicio, sus recursos y la dependencia `ws` instalada por `npm ci`. Esbuild (dependencia de desarrollo fijada en el lockfile) minifica JavaScript durante este empaquetado para respetar el límite de variables del arranque; no se necesita en la VM. No incluye `.env`, `.maritime`, audios ni el repositorio móvil. Genera variables en `.maritime/runtime-env.json`; el servicio puede arrancar con una imagen oficial e inmutable de Node usando `NODE_OPTIONS=--import=...`. El código comprimido se almacena como variable secreta de Maritime y se reconstruye en `/data/voice-runtime-<sha256>` al arrancar. No se publica una imagen con código privado en un registro público.

El Dockerfile sigue disponible para despliegues convencionales. Para actualizar el arranque alternativo, vuelve a generar el paquete, importa sus tres variables como secretos y reinicia la VM; no hace falta crear otra máquina. No publiques el archivo de variables ni lo mezcles con el código de acceso. Al ejecutar comandos Node de diagnóstico dentro de la VM, usa `env -u NODE_OPTIONS node ...` para evitar iniciar accidentalmente otra copia del servidor.

El proxy público de Maritime reserva/elimina `Authorization`. Por eso la API del canal usa `X-Voice-Token`. El servidor también acepta Bearer en conexiones directas de desarrollo, pero el SDK utiliza el encabezado propio en todas las solicitudes del canal.

Los fragmentos finales se ordenan y separan con un salto de línea antes de analizarlos. Ese límite permite validar una cita completa aunque el transcriptor omita el punto final del turno anterior. Las citas se validan literalmente contra ese texto; no se aceptan citas reconstruidas por el modelo. El SDK normaliza respuestas SDP que un proxy haya serializado como una cadena JSON.

El detector de pausas no realiza cortes forzados mientras hay voz. Android espera una pausa de 1,2 segundos para dar margen a la entrega RTP antes del commit por DataChannel; la página web conserva su detector anterior con pausas más breves. La transcripción parcial sigue siendo visible, pero los agentes analizan fragmentos cerrados. Por eso la latencia de una alerta depende de las pausas y de los modelos; no se promete una duración fija ni precisión validada para ruido o telefonía.

La app Android solicita entrada de micrófono a 48 kHz, evitando el valor de 8 kHz del emulador. Esto conserva más información acústica, pero no garantiza una transcripción perfecta. Una palabra dudosa permanece como texto sin convertirla en nombre o identidad.

## Conversación con GPT-Live 1 y marin

El modo predeterminado de la API sigue siendo `analysis`. Android añade un modo `assistant` para escuchar **y responder** por WebRTC. La página web actual conserva el modo de transcripción.

Crear la sala con el código privado en `X-Voice-Token`:

```json
{"consentimiento_analisis":true,"mode":"assistant","consentimiento_voz_ia":true}
```

La oferta mantiene el contrato `POST /v1/sessions/<id>/offer` con el ticket de productor. El servidor crea `POST /live/sessions` a través de `OPENAI_BASE_URL`, con `gpt-live-1`, voz `marin`, `store:false` y delegación `client`. Nunca entrega la API key al móvil. La respuesta incluye SDP; el audio de entrada y de salida viaja por las pistas WebRTC y los eventos por `oai-events`. Se espera `session.started`; en este modo **no** se envían commits ni eventos de la API Realtime anterior.

Solo el productor retransmite `session.input_transcript.delta`, `session.output_transcript.delta`, `session.delegation.created` y `session.closed`, dentro de `{"type":"live.event","event":{...}}`. La VM conserva deltas acotados, deduplicados por `event_id` y ordenados por `start_ms`, concatenando `delta` literalmente. No añade espacios o límites de turno inventados. Los subtítulos se agrupan por interlocutor y son parciales; no representan turnos finalizados. La voz del asistente aparece en pantalla pero se excluye del análisis de riesgo. Cada 2,5 segundos con nuevo texto se procesa una instantánea; los resultados obsoletos se descartan. Los errores nunca se convierten en FALSE.

Para comprensión Live, el servidor forma fragmentos literales y el modelo selecciona ids y tipos. El servidor resuelve cada id al texto original y aplica la misma validación de contexto completo y negaciones. Así, omitir un punto en los subtítulos no permite que el modelo reconstruya palabras, añada puntuación o atribuya identidades.

El servidor responde delegaciones y análisis mediante `live.command` con `session.thinking.append`. Android permite únicamente ese comando acotado. Las alertas son provisionales y se muestran al usuario; el agente no acusa al interlocutor ni lee puntuaciones de riesgo.

Al detener, Android retira el emisor y deshabilita el audio, envía `session.close` y espera hasta dos segundos por `session.closed` antes de liberar los transportes. Se realiza además la limpieza HTTP de la sala. Los cierres no confirmados no son evidencia de consumo final. El `/hangup` HTTP del proxy devolvió errores en las pruebas; la confirmación observada procede del DataChannel. Los WebSockets Live del proxy devolvieron 403, por eso esta integración usa WebRTC y retransmisión del productor en vez de un sideband.

### Telefonía y créditos

Esta integración atiende conversaciones **dentro de la app por internet**. No conecta por sí sola el audio de llamadas SIM ni activa desvíos. El número actual necesita desviarse a un número receptor de un proveedor con un enlace de audio compatible. Zavu documenta números y Voice Agents habilitados por equipo, con su propio pipeline de voz; no se ha verificado un puente SIP/audio externo hacia Maritime ni el acceso del cupón del evento. No se ha contratado ni configurado un número.

Las sesiones se verificaron con la credencial ya inyectada por Maritime y su proxy, sin una clave independiente de OpenAI. El resumen de uso de Maritime no desglosa minutos Live ni permite convertir los 100 créditos del evento a minutos. No se afirma que la telefonía esté cubierta ni que el saldo equivalga a USD 100. La tarifa pública de OpenAI para GPT-Live es USD 0,05/minuto, con backend y telefonía separados; no sustituye la tarifa efectiva de Maritime.

Fuentes: [tarifas OpenAI](https://developers.openai.com/api/docs/pricing), [WebRTC Live](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [sesiones y cierre](https://developers.openai.com/api/docs/guides/live-conversations), [delegación](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client), [Zavu Voice Agents](https://www.zavu.dev/es/voice-agents), [tarifas Zavu](https://www.zavu.dev/en/pricing/voice).
