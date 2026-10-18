# Fragmento telefónico y cierre de conferencia

La decisión de finalizar tiene efectos distintos: Vapi cierra el agente y Android debe cerrar también la llamada original. `call.hangup_requested` admite `risk_detected` y `agent_ended`; conserva la vinculación a la llamada, la autorización de corte, revisión e idempotencia. Un `call.ended` por desconexión de pantalla no autoriza desconectar Telecom. La APK 0.4.6 admite ambos motivos; una APK anterior solo entiende el de riesgo.

Marin usa `endCall` y la frase concreta «Voy a terminar la llamada». `endCallPhrases` configura un segundo mecanismo en Vapi. El servidor respalda las despedidas explícitas completas del asistente y los estados de proveedor `assistant-ended-call` y `assistant-said-end-call-phrase`. No interpreta las frases del llamante como órdenes de corte. Son mecanismos de ejecución, además del prompt.

## Audio conservado

- `VAPI_PHONE_EVIDENCE_ENABLED=true` habilita la capacidad del servidor; por sí solo no autoriza conservar audio.
- El monitor propietario solicita `consentimiento_conservacion:true`. En la APK se activa por separado en Ajustes de conferencia o en el canal telefónico manual. Apagado por defecto. Un observador no puede concederlo.
- Se extrae el canal customer (0) del monitor estéreo de Vapi. El mismo socket alimenta Scribe si está activo, sin una llamada adicional para guardar. También funciona con Scribe desactivado.
- Búfer solo en RAM, máximo 10 s; se borra al terminar o desconectar al propietario. No se graba la llamada completa. La instantánea de una alerta ya autorizada puede terminar de guardarse después del corte.
- Alerta del detector principal: guarda una instantánea WAV PCM16 mono 16 kHz mediante `guardar_fragmento` (API HTTP o MCP ya configurado), sin esperar el almacenamiento para terminar la llamada. El resample usa filtro para reducir alias.
- El contrato actual solo admite `source:provider_mixed` para audio del proveedor. Se conserva esa etiqueta compatible y `speaker:unknown`, pendiente de revisión, aunque el búfer contiene únicamente el canal customer. En conferencia dicho canal puede contener a más de una persona; no acredita un hablante único.
- La API crea un incidente de audio para la sesión en `org_vecinal`. Devuelve `fragment_id` e `incident_id` para localizarlo; no se adjunta automáticamente al incidente de historial creado de forma independiente por la APK.
- `audio.capture_result` usa `saving`, `saved` o `failed`. `saved` requiere un ID confirmado por el almacenamiento. El cierre puede ocurrir antes de entregar la confirmación a la APK; el resultado queda en diagnósticos de la última llamada durante diez minutos y en el panel.
- Las llamadas telefónicas usan `simulated:false`; las pruebas pueden configurar `VAPI_PHONE_EVIDENCE_SIMULATED=true`. La opción antigua de evidencia WebRTC no cambia esta clasificación.

## Comparación futura de voces

Guardar WAV no genera una huella vocal. La API admite `/voice-samples` con embeddings y propone vínculos entre incidentes con modelo y versión compatibles, revisión y autorización de referencia. Aún falta un motor de embeddings real conectado a estos fragmentos. No se generan vectores ficticios ni se activa automáticamente `reference_enabled`. Esta versión permite conservar y escuchar evidencia para revisión; todavía no reconoce una voz al volver a llamar ni cuelga por similitud vocal.

Validación: pruebas de órdenes de cierre, negaciones y hablantes; consentimiento, revocación, almacenamiento asíncrono y fallos; ventana acotada y filtro de resample; compilación, tests y lint Android. Prueba HTTP con tono sintético: subida, recuperación idéntica por SHA-256 y eliminación del incidente de prueba. La prueba de conferencia real requiere instalar la nueva APK.
