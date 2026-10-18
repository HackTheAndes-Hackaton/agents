# Dos agentes contra estafas y extorsiones

**Reportes automáticos de pruebas con Maritime o Grok:** [configuración, permisos y flujo](docs/GROK_REPORTES.md).
La extracción y el resumen se elaboran al cerrar la sesión autorizada, sin sustituir la voz ni la detección existentes.

Prototipo en español basado en el resumen de HackTheAndes:

1. **andes-comprension** organiza citas literales de la transcripción autorizada y categorías para revisar, sin atribuir identidades ni hablantes.
2. **andes-deteccion** evalúa la transcripción original con `gpt-6-luna` mediante OpenAI Decisions y devuelve `true` o `false` para una alerta preventiva. El análisis previo no se utiliza como evidencia para el detector.

Cada agente usa el mismo servidor y un valor distinto de `AGENT_ROLE`. Comprensión conserva `gpt-4.1-mini` y sus citas se comprueban contra la transcripción. Detección recibe una probabilidad tipada, no texto generado, y el código la convierte en booleano. El resultado es provisional y requiere revisión humana.

## Uso

Node.js 24 o posterior. Ejecuta `npm ci` para instalar la dependencia WebSocket.

```sh
export OPENAI_API_KEY=tu-clave
export AGENT_ROLE=comprension
npm start
npm test
```

`GET /health` comprueba el servidor sin invocar al modelo. `POST /chat` recibe `{"message":"<incidente JSON serializado>"}`. El incidente debe incluir `consentimiento_analisis: true` y `transcripcion` no vacía. Comprensión responde con `{"response":"<análisis JSON serializado>"}`; Detección usa `{"response":"true"}` o `{"response":"false"}`. Este sobre conserva el contrato de Maritime: el contenido del detector se convierte a booleano con `JSON.parse(response)`. Un saludo devuelve instrucciones sin llamar al modelo.

Los archivos de `examples/` contienen escenarios ficticios. Tras el despliegue:

```sh
node scripts/analizar.mjs examples/legitimo.json
node scripts/analizar.mjs examples/riesgo.json
maritime status andes-comprension --json
maritime status andes-deteccion --json
```

El flujo duerme Comprensión antes de llamar a Detección porque el plan gratuito permite una máquina despierta a la vez.

## Canal de voz desplegado

**andes-voz:** https://api.maritime.sh/a/ebf0eb81-42c0-4437-a044-1af84af1b755

Abre la página HTTPS, introduce el código privado del equipo, confirma la autorización y conecta un micrófono o un archivo de prueba. La página muestra transcripción, alerta booleana y comprensión. El código se encuentra localmente en `.maritime/voice-access.json`, excluido de Git. En Android también se puede abrir Inicio → Abrir canal de voz, con captura nativa a 48 kHz y creación automática de su sala. El modo demo de llamadas es independiente. La página web conserva la opción de conectar un observador temporal. No distribuyas el código maestro en una aplicación publicada.

El módulo `web/voice-client.js` también recibe un `MediaStream` existente mediante `connectVoice`, para integrarlo con otro intermediario WebRTC. Consulta [el contrato de integración](docs/canal-voz.md). El servicio reúne los dos agentes lógicos en una VM; las otras dos máquinas pueden permanecer dormidas. La transcripción y la inferencia consumen créditos de IA.

## Configuración

- `AGENT_ROLE`: `comprension`, `deteccion` o `voz` (canal WebRTC).
- `VOICE_ACCESS_CODE`: obligatorio para el canal de voz público, al menos 12 caracteres aleatorios. Nunca lo incluyas en un cliente distribuido.
- `OPENAI_API_KEY` y `OPENAI_BASE_URL`: acceso al modelo; Maritime puede inyectarlos al habilitar su proxy.
- `OPENAI_MODEL`: por defecto `gpt-4.1-mini`; debe estar disponible en el proveedor.
- `OPENAI_DECISION_MODEL`: por defecto `gpt-6-luna` para Detección. Requiere el endpoint `/decisions`, comprobado a través del proxy de Maritime el 17/10/2026.
- `ALERT_THRESHOLD`: umbral de alerta entre 0 y 1; valor provisional `0.5`. No está calibrado para estafas en español: debe elegirse con ejemplos etiquetados según los costos de falsas alarmas y casos omitidos.
- `PORT`: puerto inyectado por Maritime; 3000 en desarrollo. Se escucha en `0.0.0.0`.
- `PERSIST_HISTORY`: desactivado por defecto. Con `true`, conserva diez intercambios por `conversationId` bajo `DATA_DIR` (por defecto `/data`). Usa IDs distintos para incidentes independientes.

El agente no guarda transcripciones en disco por defecto. El procesamiento sí envía texto al proveedor del modelo; esta opción no controla la retención de Maritime ni del proveedor. El permiso para analizar es independiente del permiso para conservar o compartir. Las llamadas al modelo consumen créditos de IA separados del alojamiento.

Detección no guarda historial aunque se active `PERSIST_HISTORY`. `true` pide revisar una posible situación de riesgo; `false` indica que la probabilidad quedó por debajo del umbral, sin garantizar seguridad. Fallos de red, probabilidades inválidas y negativas del modelo generan errores HTTP; no se convierten en `false`. OpenAI Decisions está en beta pública. [Documentación y precio del endpoint](https://developers.openai.com/api/docs/guides/decisions): USD 0.10 por millón de tokens de entrada, sin cobro de salida; comprueba el consumo real en Maritime.

## Despliegue

El Dockerfile está en la raíz. Crea dos agentes de framework `custom` con el mismo código y configura su rol antes de probarlos. El CLI permite subir código local con `maritime agents create --from-dir . --name <nombre> --framework custom --use-maritime-llm --idle-ttl-seconds 600 --json`; esta vía evita requerir acceso del constructor a GitHub privado. El código también puede desplegarse desde GitHub conectando la aplicación de Maritime.

Los roles de texto deben permanecer detrás del acceso autenticado de Maritime: no implementan autenticación propia. El rol `voz` puede ser público porque protege la creación de salas con un código privado y emite tickets limitados por sesión. Las llamadas al proveedor tienen un límite de 24 segundos para respetar el presupuesto de respuesta de Maritime.

Los dos agentes se crearon desde el archivo del código de este repositorio, mediante subida local. No se configuró despliegue automático desde GitHub. Los IDs y roles están en `deploy/agentes.json`; el directorio está vinculado a Comprensión mediante `.maritime/` (ignorado por Git). `maritime.json` y la habilidad de `.claude/skills/maritime/` permiten retomar la operación. Usa siempre el nombre explícito para operar Detección.

Con maritime-cli 2.0.1, el comando abreviado `maritime chat <nombre> <JSON>` puede alterar la entrada JSON. El script usa `maritime agents chat <id> --message <JSON> --json`, que conserva el contenido. Los parámetros de `--stdin` deben incluir el cuerpo completo: esa modalidad no incorpora las opciones de creación adicionales.

## Alcance

Esta entrega procesa transcripciones y ofrece un canal de voz propio con `AGENT_ROLE=voz`. Su página admite micrófono y archivos; el módulo JavaScript acepta también el `MediaStream` de un intermediario WebRTC. La señalización pasa por Maritime y el audio va al transcriptor de OpenAI. Los dos agentes lógicos se ejecutan en la misma VM para permitir alertas continuas con el límite gratuito de una máquina despierta.

Consulta [el contrato del canal y la conexión de Tiskz](docs/canal-voz.md). La app Android integra el canal de voz; no captura audio de llamadas de operadora. Los agentes no presentan denuncias, publican sospechosos ni identifican personas por su voz. El detector evalúa el texto y el contexto; no escucha tono ni verifica identidad. La interfaz muestra los errores de transcripción y análisis.

Los prompts de cada rol están en `prompts/`. Los ejemplos y las pruebas no demuestran precisión general ni probabilidades calibradas.

La API de voz ofrece también `mode: "assistant"`: GPT-Live 1 responde en español con voz `marin`, mientras los dos agentes analizan únicamente los subtítulos de quien llama. Requiere consentimiento específico y la app Android actualizada. Véanse el contrato, las limitaciones de telefonía y el cierre de consumo en [canal de voz](docs/canal-voz.md#conversación-con-gpt-live-1-y-marin).

Para recibir alertas de llamadas atendidas por un número de Vapi, consulta [llamadas telefónicas con marin](docs/LLAMADAS_VAPI.md). Ese canal usa saldo de Vapi para voz y créditos de Maritime para los dos análisis. El desvío de la línea Entel debe habilitarlo la operadora; esta integración no lo activa.
# Evidencia de audio por MCP

La APK puede autorizar por separado `consentimiento_conservacion: true` al crear una sesión WebRTC. Con su ticket productor puede usar `POST /v1/sessions/{id}/evidence` (`request_id` UUID y `audio_base64` WAV), `GET` para listar y `GET /v1/sessions/{id}/evidence/{clip_id}` para reproducir. El ticket observador no puede acceder a estas rutas y al finalizar la sesión todos sus tickets vencen.

Configura en el servidor `TISKZ_MCP_URL`, `TISKZ_API_KEY` y `TISKZ_ORG_ID=org_vecinal`. El MCP se implementa en el repositorio web, sobre Postgres, y debe desplegarse antes de probar el guardado. La clave de la API nunca llega al cliente. El backend fija organización, sesión, procedencia del micrófono y estimación provisional; no acepta nombres, números o puntuaciones inyectados en la carga del cliente.

Las herramientas son `guardar_fragmento`, `listar_fragmentos` y `escuchar_fragmento`. Conservar un WAV no crea una identidad ni un embedding. Esta primera conexión cubre el micrófono WebRTC; las alertas telefónicas de Vapi todavía no aportan audio original. SMS y corte remoto no se ejecutan por estas herramientas.


## Orden automática de captura

Las nuevas APK anuncian `audio_capture_protocol: 1` al crear una sesión con conservación autorizada. Una detección TRUE de la revisión actual produce `audio.capture_requested` únicamente en el WebSocket productor: `session_id`, `request_id` UUID, `revision`, `window_ms: 10000` y `expires_at` (30 s). No se dispara con FALSE, errores, análisis obsoleto ni sin autorización. Se confirma una captura automática por sesión; tras fallos puede solicitarse de nuevo en una revisión posterior, hasta tres solicitudes.

La APK responde `audio.capture_received`, toma los últimos segundos disponibles al recibir la orden y sube WAV usando ese `request_id`. No equivale a localizar exactamente la frase que originó el análisis. Si no hay audio o está ocupada responde `audio.capture_failed`. El servidor emite `audio.capture_result` (`saved` y `fragment_id`, o `failed` y motivo) después de consultar el almacenamiento. El cliente no puede confirmar por sí mismo que quedó guardado. Las órdenes vencidas no se ejecutan; un reintento de subida conserva su ID y la puntuación de la detección que lo originó.

Con `TISKZ_AUDIO_API_URL=https://web-repo-xi.vercel.app/api/v1/audio-fragments` el backend usa la API HTTP directamente. Sin esa configuración mantiene compatibilidad con MCP. Ambas entradas comparten el mismo servicio de persistencia en el panel. La clave global nunca se distribuye a la APK. Para estas pruebas `TISKZ_EVIDENCE_SIMULATED=true` separa la evidencia de las llamadas reales.

## Evaluación incremental y orientación basada en evidencia

La [aplicación práctica de los estudios](docs/INVESTIGACION_APLICADA.md) incluye 20 conversaciones sintéticas en español, un evaluador por turno y la política `observar / verificar / alertar / inconcluso`. `assessment.update` reúne resultados de la misma revisión y citas literales. La web muestra la orientación y GPT-Live recibe pautas redactadas por el servidor. La telefonía Vapi emite el evento para sus clientes; dibujarlo en Android requiere integrar ese nuevo tipo de evento.

Ejecuta `npm test` sin créditos o `node scripts/evaluar-fraude.mjs eval/results/nueva-ejecucion.json` con el proveedor configurado para medir los modelos. `eval/contraejemplos-es-PE-v1.json` reúne 24 llamadas legítimas que se parecen a una estafa (cada una indica a qué caso de estafa se parece en `relacionado_con`); para medir sus falsas alertas, pásalo como segundo argumento: `node scripts/evaluar-fraude.mjs eval/results/contraejemplos.json eval/contraejemplos-es-PE-v1.json`. Los resultados de desarrollo no demuestran precisión en llamadas reales. El canal acústico permanece explícitamente `no_evaluada`; no se deduce voz sintética ni identidad a partir de una transcripción.

## Comunicación con los avisos de la APK

El [contrato de avisos locales](docs/CONTRATO_AVISOS_APK.md) define estado, motivo, porcentaje y revisión por WebSocket. La APK construye la notificación Android. No se necesita Firebase para este canal. El backend entrega `alertar` antes del corte aunque comprensión siga pendiente, y después añade motivos basados en las categorías de evidencia. El monitor autorizado debe permanecer conectado durante la llamada; una Activity o notificación por sí sola no lo mantiene.


## Comparación de transcripción telefónica

El [canal paralelo de Scribe](docs/SCRIBE_PARALELO.md) compara subtítulos y detección durante la llamada, manteniendo marin y el corte existentes. La APK 0.4.5 lo presenta por separado y confirma la recepción de las alertas.
