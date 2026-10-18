# Reconocer la voz de un estafador en llamadas desde otros números

Función clave de PhoneWard: si una voz ya quedó registrada en una estafa confirmada, se reconoce cuando vuelve a llamar desde otro número a cualquier usuario del sistema. Es una pista revisable: no identifica a una persona ni prueba un delito.

## Flujo

1. **Comparar (toda llamada desconocida con permiso).** El servidor escucha solo el canal del llamante en Vapi. Con 6 s de voz (sin silencios) calcula una huella temporal y consulta `POST /api/v1/voice-matches/search`. Si la similitud supera 0,70 envía `voice.match` a la app («Voz parecida a un estafador reportado · N casos»). Esa huella no se guarda.
2. **Referencia ya conocida.** Una coincidencia fuerte (≥ 0,80 y al menos un caso) solicita el corte preventivo aunque el contenido no active una alerta, únicamente con permiso vigente de voz y corte automático. Publica primero `voice.match`, después `call.hangup_requested` con `reason: voice_match`, `block_number: true` e `identity_verified: false`. La APK bloquea localmente el número de la llamada original que obtuvo de Telecom, nunca un número enviado por el servidor ni el de Vapi. No se vuelve a guardar la huella como confirmación. Una coincidencia intermedia solo avisa.
3. **Recolectar una muestra nueva.** Sin una coincidencia fuerte, una alerta del contenido con probabilidad ≥ 0,90 puede activar la recopilación autorizada: el servidor envía una instrucción interna por el control de Vapi (`add-message`) para continuar la conversación sin compartir información sensible. Emite `voice.collecting` con `status: started`. La alerta es provisional y no confirma un delito.
4. **Guardar y cortar.** Con 20 s de voz (o 60 s como máximo) calcula hasta tres huellas y las envía a `POST /api/v1/voice-matches/enroll`; después pide el corte habitual. Si el estafador cuelga antes y ya hay al menos 6 s de voz, se guarda lo juntado.

## Datos

- Se guardan solo huellas (vectores de 256 números) del canal del llamante, nunca audio, en `voice_samples` con `review_status: pendiente`. El panel puede rechazarlas: una muestra rechazada deja de usarse.
- La búsqueda abarca todas las organizaciones y devuelve solo totales: similitud, casos, casos revisados, última vez y tipo de estafa.
- El número del llamante queda en los metadatos del incidente de voz, no en `caller_e164`, para no contar dos veces la misma llamada en la reputación del número.
- Pruebas y llamadas reales no se mezclan (`simulated`).

## Permiso

La app envía `consentimiento_huella_voz` junto con la opción de conservar la voz que ya existe en Ajustes. Sin ese permiso el servidor no escucha el audio ni compara.

## Motor

`sherpa-onnx-node` 1.13.8 con el modelo WeSpeaker ResNet34 (VoxCeleb), en un hilo aparte (unos 250 ms por huella). Se instala en `/data/voiceprint` con `scripts/instalar-voiceprint.sh`, que verifica el SHA-256 del modelo. Si falta el motor, la función queda apagada y el resto del servidor sigue igual.

## Configuración del servidor

| Variable | Valor por defecto |
| --- | --- |
| `VOICEPRINT_ENABLED` | `false` |
| `VOICEPRINT_DIR` | `/data/voiceprint` |
| `VOICEPRINT_SEARCH_SECONDS` | `6` |
| `VOICEPRINT_NOTIFY_SIMILARITY` | `0.7` |
| `VOICEPRINT_STRONG_SIMILARITY` | `0.8` |
| `VOICEPRINT_CONFIRM_PROBABILITY` | `0.9` |
| `VOICEPRINT_COLLECT_SECONDS` | `20` |
| `VOICEPRINT_COLLECT_MAX_MS` | `60000` |
| `VOICEPRINT_SIMULATED` | `false` |

También usa `TISKZ_API_URL`, `TISKZ_API_KEY` y `TISKZ_ORG_ID`. `GET /health` informa `voiceprint.engine_ready`.

## Límites

Los umbrales se probaron con voces sintéticas: la misma voz dio 0,95–0,96 y voces distintas 0,37–0,52, también simulando audio telefónico de 8 kHz. Con voces humanas reales y audio de conferencia los valores serán más bajos; hay que calibrarlos con llamadas reales antes de confiar en ellos. En una conferencia, el canal del llamante podría incluir eco del usuario.

El bloqueo solicitado para la demo es una acción preventiva autorizada por los permisos de la sesión, no una identificación de personas. La búsqueda actual incluye muestras pendientes de revisión; rechazarlas en el panel las retira de las comparaciones. El número se guarda solo en la lista local de bloqueo de la APK. La similitud no infla el porcentaje del análisis textual ni publica otra denuncia automáticamente.
