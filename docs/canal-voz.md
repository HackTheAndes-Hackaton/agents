# Canal de voz de Tiskz

`AGENT_ROLE=voz` ejecuta un servidor de señalización WebRTC, un canal WebSocket de eventos y los dos agentes lógicos en una sola VM de Maritime. Así no es necesario despertar simultáneamente las otras dos máquinas del plan gratuito. Las inferencias y la transcripción consumen créditos del proveedor; el alojamiento gratuito no implica audio ilimitado.

## Flujo

1. El navegador/intermediario obtiene un `MediaStream` autorizado: micrófono, archivo de prueba o pista recibida por otro WebRTC.
2. `POST /v1/sessions` con `Authorization: Bearer <VOICE_ACCESS_CODE>` y `{"consentimiento_analisis":true}` devuelve una sala, un ticket de productor y otro de observador. La duración máxima es de 15 minutos, con dos sesiones simultáneas.
3. El productor conecta `/ws/calls?session=<id>&ticket=<producer_token>`.
4. Crea un `RTCPeerConnection`, añade la pista de audio y crea un DataChannel. Envía su oferta SDP a `POST /v1/sessions/<id>/offer`, autenticado con el ticket de productor. Recibe el SDP de respuesta.
5. La negociación y la credencial de Maritime permanecen en el servidor. Los paquetes de audio WebRTC viajan desde el cliente al proveedor OpenAI; la VM no retransmite ese audio. El modelo `gpt-live-transcribe` devuelve fragmentos por DataChannel. El cliente detecta pausas y realiza `input_audio_buffer.commit`.
6. El productor reenvía eventos `transcript.update` al servidor. Los finales disparan GPT Decisions (`gpt-6-luna`) y comprensión (`gpt-4.1-mini`) con el contexto acumulado. Los parciales solo se muestran. Las revisiones obsoletas y finales duplicados se descartan.
7. `alert.updated` contiene `alerta: true|false`, `probability`, `threshold`, `revision` y `provisional:true`. `understanding.update` contiene hechos, inferencias y citas literales. Un fallo del modelo produce `error`, nunca un FALSE de sustitución.
8. Terminar: `POST /v1/sessions/<id>/end` con el ticket del productor; cierra también la llamada del proveedor. Desconectar al productor concede cinco segundos para reconectar y después termina la sesión.

El módulo `/voice-client.js` exporta `connectVoice({stream, accessCode, consentimiento:true, baseUrl, onEvent})`, que devuelve `{stop, peerConnection, sessionId}`. Es la integración mínima para un intermediario web propio. Sirve el cliente en el mismo origen; no se habilita CORS público. Para un intermediario de otro origen, utiliza su backend de confianza para crear y negociar la sesión o implementa una política explícita de orígenes permitidos. Nunca distribuyas la clave del proveedor ni el código maestro dentro de una app publicada: tu backend debe emitir tickets limitados por sesión.

## App Android existente

Repositorio inspeccionado: https://github.com/HackTheAndes-Hackaton/mobile-repo (Kotlin, Tiskz).

En Settings, desactiva Demo Mode y pega en WebSocket URL la URL de observador que muestra la página después de conectar el audio. Se puede mantener Backend URL en el origen HTTPS del servicio. El cliente ya acepta parámetros de consulta y añade `caller`; este número no autentica ni identifica al hablante.

Se emiten los formatos existentes `agent.status`, `transcript.update`, `risk.update`, `call.ended` y `error`. Los eventos nuevos son ignorados por el parser antiguo. El ticket de observador puede ver la sesión y enviar las decisiones de interfaz existentes. `reject`, `hang_up`, `block` y `answer` terminan **esta sesión de análisis**; no ejecutan acciones en la red telefónica ni registran números en una lista de bloqueo. `not_scam` solo comunica una corrección humana; no reentrena el modelo.

El campo antiguo `risk_percent` se utiliza por compatibilidad para mostrar la probabilidad de que corresponda emitir una alerta, **no una probabilidad validada de estafa**. Se acompaña de `score_kind` y una explicación en `reasons`. Antes de una demo pública, conviene adaptar esa etiqueta de la app. No se emiten coincidencias biométricas ni `call.ready_to_answer`; un FALSE no autoriza contestar automáticamente.

No se ha modificado ni compilado la app móvil. Tampoco existe captura universal de llamadas de operadora: para analizar llamadas reales se necesita una fuente de audio autorizada del proveedor de telefonía o de la sesión WebRTC propia.

## Datos y acceso

El servidor conserva texto solo en memoria durante la sesión y no escribe grabaciones ni transcripciones en disco. El proveedor de IA procesa el audio y el texto según su política de datos. El productor autenticado remite las transcripciones: esta arquitectura es apropiada para el intermediario del equipo, no ofrece evidencia forense de que cada texto provenga del audio. En producción, conecta una sesión lateral de servidor para verificar los eventos del proveedor.

El código privado se guarda localmente en `.maritime/voice-access.json`, excluido de Git y con permisos 0600. No pegues tickets de sesión en repositorios, informes públicos o capturas. Los tickets caducan con la sala. Al reiniciar/dormir la VM, las salas en memoria se pierden.

## Validación

`npm test` verifica consentimiento, aislamiento entre salas, roles del WebSocket, deduplicación, revisiones, fallos del modelo, negociación SDP y cierre del proveedor. Las pruebas unitarias utilizan proveedores simulados; la prueba de audio real del despliegue se registra por separado en `deploy/verificacion-voz.json`.

Referencia de transcripción: https://developers.openai.com/api/docs/guides/realtime-transcription
Referencia de WebRTC: https://developers.openai.com/api/docs/guides/voice-webrtc?api=realtime

## Arranque alternativo sin constructor remoto

Si el constructor de ZIP queda bloqueado, `node scripts/preparar-runtime.mjs` empaqueta únicamente el código del servicio, sus recursos y la dependencia `ws` instalada por `npm ci`. No incluye `.env`, `.maritime`, audios ni el repositorio móvil. Genera variables en `.maritime/runtime-env.json`; el servicio puede arrancar con una imagen oficial e inmutable de Node usando `NODE_OPTIONS=--import=...`. El código comprimido se almacena como variable secreta de Maritime y se reconstruye en `/data/voice-runtime-<sha256>` al arrancar. No se publica una imagen con código privado en un registro público.

El Dockerfile sigue disponible para despliegues convencionales. Para actualizar el arranque alternativo, vuelve a generar el paquete, importa sus tres variables como secretos y reinicia la VM; no hace falta crear otra máquina. No publiques el archivo de variables ni lo mezcles con el código de acceso. Al ejecutar comandos Node de diagnóstico dentro de la VM, usa `env -u NODE_OPTIONS node ...` para evitar iniciar accidentalmente otra copia del servidor.
