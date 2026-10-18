# Agente → avisos locales de la APK

Se revisó `mobile-repo/main` en `82e21f5`: la APK construye sus avisos Android en `CallNotifications`, a partir del análisis que recibe. Este servidor entrega eventos WebSocket; no envía notificaciones por Firebase ni requiere instalar otro proveedor.

## Conexión y responsabilidad de cada lado

La APK necesita una sesión autorizada `PhoneAlertSession` viva durante la llamada. Esta usa `POST /v1/phone/monitor` con consentimiento y código privado, obtiene un ticket temporal y conecta `/ws/calls?channel=phone&ticket=...`. El código no debe ir en la URL. El backend solo analiza mientras hay un observador autorizado; cerrar la última conexión revoca el análisis. Una notificación Android por sí sola no abre esa conexión.

En el main revisado, `TelecomConferenceRuntime` es propietario del monitor en una conferencia automática. `VoiceScreen` también puede abrirlo manualmente y lo cierra al salir. La ruta genérica `WebSocketAnalysisSession` no sustituye el protocolo telefónico autenticado de Maritime. El equipo de APK debe mantener el monitor desde el ciclo de vida de la llamada para que los avisos no dependan de tener una Activity abierta. Este cambio del agente no habilita la conferencia, no confirma costos ni instala servicios en segundo plano.

## Eventos consumidos por la APK

Todos incluyen `session_id` y `revision`. Los de este ejemplo son ficticios:

```json
{"type":"assessment.update","session_id":"call-id","revision":7,"provisional":true,"explanation_pending":false,"assessment":{"version":"orientacion_v1","estado":"verificar","motivo":"Señales seleccionadas en el texto: una petición de dinero. No verifican una identidad ni confirman una estafa.","orientacion":"Antes de cualquier pago, verifica por un canal conocido.","alerta":false,"evidencia_textual":[{"tipo":"peticion_pago","cita":"Necesito dinero."}],"identidades_verificadas":[],"acciones_automaticas":false}}
{"type":"risk.update","session_id":"call-id","revision":7,"risk_percent":10,"alerta":false,"reasons":["Señales seleccionadas en el texto: una petición de dinero. No verifican una identidad ni confirman una estafa."],"score_kind":"probabilidad_de_alerta_no_calibrada","scam_type":null,"impersonating":null}
```

- `assessment.estado` es `observar`, `verificar`, `alertar` o `inconcluso`; la APK ya lo traduce a `CallAnalysis.currentAssessment.state`.
- `assessment.orientacion` llega a `currentAssessment.guidance` para la recomendación visible.
- `assessment.motivo` se repite en `risk.update.reasons[0]`, que ya llega a `CallAnalysis.reasons` y puede usar el aviso actual.
- El porcentaje viene del detector, sin inflarlo por palabras clave. No se deduce el estado a partir de ese porcentaje ni se verifica identidad.
- Las citas son texto recibido, no instrucciones a ejecutar. El motivo breve lo redacta el servidor usando categorías seleccionadas y verificadas contra el texto, sin copiar nombres ni prosa libre del modelo.

La primera detección se envía inmediatamente al responder el detector. Si es TRUE, se publica `alertar` **antes de solicitar el corte**, aunque comprensión siga pendiente (`explanation_pending: true`, sin citas inventadas). Cuando ambos agentes completan la misma revisión, se publica el motivo más concreto. Una orientación negativa no se completa sin comprensión; un fallo nunca se convierte en FALSE ni fabrica 0 %.

El main revisado de `CallNotifications.noticeFor` todavía decide sus etiquetas principalmente con `alert/isScam/isSafeToAnswer`; el equipo de APK debe tomar `currentAssessment.state` si quiere distinguir los cuatro nombres en su notificación. El backend no emite `safe` ni una identidad verificada para forzar la etiqueta «Llamada segura».

## Corte y diagnóstico

El corte conserva el contrato existente: `call.hangup_requested` con sesión, llamada, UUID y revisión; luego `call.hangup_result`. Solo `call.ended` con motivo del proveedor confirma el fin de Vapi. No equivale a comprobar que Android desconectó una conferencia manual de Entel.

`GET /v1/phone/diagnostics`, con `X-Voice-Token`, añade `currentCall` y `lastCall`: revisión, estado, alerta, duración de cada inferencia y estado de la solicitud de corte. El último resumen solo vive en memoria y deja de exponerse pasados diez minutos; desaparece al reiniciar. No contiene transcripción, audio, teléfono, nombre ni URL privada de control. Permite correlacionar el ID con Vapi sin conservar el contenido de la conversación.

## Demora y saludo

La espera artificial antes de analizar un turno final telefónico se reduce de 2,000 a 250 ms. Esto no cambia el tiempo que necesita el modelo, la red o Vapi para producir la transcripción. Los deltas de GPT-Live mantienen su agrupación anterior; no se confunde un parcial con un turno completo.

Vapi conserva marin y el modo de hablar primero, con «Hola, dime.». `startSpeakingPlan.waitSeconds` pasa de 1.0 a 0.4 s, siguiendo la [configuración de toma de turno](https://docs.vapi.ai/customization/speech-configuration). Se añade un único aviso «Hola, ¿me escuchas?» si no responde quien llama, con timeout de 6 s y sin reiniciar el contador. El [hook de silencio](https://docs.vapi.ai/assistants/idle-messages) puede sumar procesamiento; no garantiza hablar exactamente al sexto segundo.

En pruebas WebSocket sin voz del usuario, el saludo ya se oía antes del ajuste (848 ms desde conectar; 2,047 ms desde solicitar la llamada). Tras el ajuste se oyó a 833 ms desde conectar (1,911 ms desde solicitar), y otro segmento de voz a 8,858 ms. Esas dos muestras no demuestran una mejora estadística de latencia ni validan Entel. El recordatorio permite recuperar una apertura que pudiera haberse oído antes de unir una conferencia; esa explicación sigue siendo una hipótesis hasta probarla en el teléfono físico.

## Verificación del servidor publicado

[Registro de la prueba](verificacion-avisos-backend.json): 68 pruebas Node y servidor activo con health/chat 200. Una llamada sintética de riesgo produjo `alertar`, solicitud de corte, aceptación y fin confirmado por Vapi; la primera orientación precedió a la orden de corte. Detección tardó 797 ms y comprensión 1330 ms desde su invocación, además de la espera de entrada y red. Una llamada legítima pasó de `inconcluso` a `observar`, con FALSE, comprensión y ninguna orden de corte. Ambas pruebas cumplieron la comprobación de transcripción literal prevista por el fixture. No es una medición de exactitud general de ASR ni una prueba del teléfono físico.
