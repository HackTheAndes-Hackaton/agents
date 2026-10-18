# Comparación de Scribe y Realtime durante una llamada

`VAPI_SCRIBE_SHADOW_ENABLED=true` habilita una transcripción comparativa en la VM existente. Requiere `VAPI_API_KEY` en el servidor y un monitor autorizado de la APK. Está apagada por defecto. La llamada original conserva GPT Realtime 2 y marin; sus transcripciones y decisiones siguen controlando el corte.

Vapi entrega en `monitor.listenUrl` una cabecera `start` con formato y dos canales PCM. El servidor exige `linear16`, `raw` y dos canales identificados. Extrae únicamente el canal customer (0), conservando muestras partidas entre frames. La voz del agente (canal 1) se descarta. No se intenta inferir quién habla por su voz ni se acepta un flujo mono que mezcle ambos extremos.

El audio del llamante se envía a una sesión WebSocket temporal de Vapi con ElevenLabs `scribe_v2_realtime`, español, `silenceThresholdSeconds: 0.3` y `minSilenceDurationMs: 300`. Usa el saldo Vapi existente y no necesita una nueva key de ElevenLabs. La sesión auxiliar requiere un modelo conversacional estándar; sus respuestas se descartan y nunca se reproducen en la llamada real. No tiene número telefónico, herramientas de corte, webhooks a Maritime ni grabación o historial habilitados.

## Contrato de comparación

- `comparison.status`: `starting`, `streaming`, `stopped` o un motivo de indisponibilidad.
- `transcript.comparison`: `id`, `sequence`, `text`, `final`, `source: scribe_v2_realtime`, `comparison_only: true`, `received_at_ms` y `audio_received_ms`. Un parcial reemplaza al anterior con el mismo ID; un final cierra ese segmento.
- `comparison.alert`: resultado del detector existente sobre los finales acumulados de Scribe; incluye revisión independiente, probabilidad, `analysis_ms`, `caption_to_alert_ms` y `comparison_only: true`. Nunca modifica `alert.updated`, la comprensión principal, `call.ready_to_answer` ni la orden de corte.

La APK 0.4.5 presenta una tarjeta independiente en la llamada y en Voz en vivo. No mezcla esos textos con la conversación principal ni genera una notificación de riesgo a partir de la comparación. Los parciales no deciden alertas ni cortes.

Los eventos `alert.updated` y `comparison.alert` llevan `event_id` y `server_sent_at_ms`. Tras actualizar su estado, la APK responde `event.received` con ese ID y `session_id`. El diagnóstico guarda el tiempo completo servidor–APK–servidor en `delivery.server_round_trip_ms`. No equivale al tiempo de ida ni confirma que Android haya dibujado una notificación. No requiere sincronizar relojes.

## Cierre y límites

Al terminar la llamada, revocar el último monitor o apagar el servidor se cierran ambos WebSockets y se envía `end-call` a la sesión auxiliar. Existe además un límite remoto de cuatro minutos. Se descartan eventos tardíos. Un fallo de Scribe no interrumpe marin ni produce FALSE. El búfer de arranque está limitado a ocho segundos y la cola de envío a cuatro; una sobrecarga cancela la comparación sin omitir audio silenciosamente.

El servidor conserva audio únicamente en tránsito. Las transcripciones de comparación se mantienen durante la llamada y se borran al terminar. El diagnóstico retiene diez minutos de metadatos sin contenido: estados, contadores, duraciones e ID auxiliar. Las grabaciones e historial del proveedor permanecen desactivados; esto no equivale a contratar Zero Data Retention.

## Paquete de Maritime

Si el código comprimido supera el límite del entorno, `scripts/preparar-runtime.mjs` genera `.maritime/runtime-bundle.br` y variables que apuntan a `/data/voice-runtime-bundles/<sha256>.br`. Subir el paquete y verificar su SHA-256 antes de importar el entorno y recargar. El arranque comprueba el hash. Al pasar desde el paquete inline anterior, quitar `VOICE_RUNTIME_B64` antes de recargar; el servicio en ejecución sigue atendiendo hasta la recarga. No recargar con una llamada o monitores conectados.

Fuentes: [protocolo multicanal de Vapi](https://docs.vapi.ai/customization/custom-transcriber), [escucha en vivo](https://docs.vapi.ai/calls/call-features), [Scribe en Vapi](https://docs.vapi.ai/providers/transcriber/elevenlabs).
