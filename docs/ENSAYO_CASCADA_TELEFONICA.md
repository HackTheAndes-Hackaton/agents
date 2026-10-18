# Ensayo de cascada en la conferencia telefónica

18 de octubre de 2026. Estado actual: el número existente de Vapi `+1 209 819 5098` usa el asistente `2bccff10-dfc6-4ea4-a235-f254830111f4`, con Soniox `stt-rt-v5` en español → GPT-4.1 mini → Eleven Flash v2.5, voz Sarah. Configuración revisable en `config/vapi-cascade-assistant.json`. La comparación y validación del nuevo transcriptor están en `docs/COMPARACION_TRANSCRIPTORES.md`. Las medidas históricas siguientes corresponden a Scribe v2 Realtime salvo indicación expresa; no se extrapolan a Soniox. No usa la instancia de ElevenLabs Agents de la prueba WebRTC: Vapi orquesta directamente los componentes a través de sus integraciones.

No hay transferencia SIP, compra de número ni portabilidad. Vapi factura la conversación con sus integraciones; los créditos de Maritime cubren los análisis que se ejecutan allí, no se presume que paguen el procesamiento de voz de Vapi.

## Servidor y APK

Se mantiene el runtime existente de `andes-voz` (`ebf0eb81-42c0-4437-a044-1af84af1b755`). Cambios de entorno: `VAPI_ASSISTANT_ID` al candidato y `VAPI_LIVE_MCP_ENABLED=false`, seguidos de reinicio. Ahora el backend procesa los eventos nativos `transcript` en vez del reporte textual del reasoner por MCP. Conserva el secreto del webhook, el código privado del equipo, los endpoints y el contrato de eventos de la APK. Scribe shadow y conservación de audio continúan desactivados.

No se recompiló ni reemplazó la APK para esta ruta. En el Samsung conectado se comprobó Tiskz 0.4.6, rol de marcador predeterminado, conferencia automática y confirmación de costos previamente activadas, destino Vapi y URL de backend correctos. No se modificaron esos permisos ni ajustes.

`/health` todavía contiene etiquetas históricas para el modelo de telefonía: cuando Live está apagado informa `gpt-realtime-2`. Para este ensayo, la fuente de configuración real es el asistente leído desde Vapi; no presentar esa etiqueta como validación de GPT Realtime. La ruta de conversación directa por internet con marin permanece independiente.

## Pruebas previas a la llamada real

Audio ficticio Paulina, limitado a banda telefónica y PCM mono de 8 kHz, enviado a ritmo real al transporte WebSocket de Vapi. No es una conferencia PSTN.

| Caso | Primer audio después del habla | Alerta después del habla | Resultado |
| --- | ---: | ---: | --- |
| Reunión, sin pagos ni códigos | 2456 ms | 2926 ms | `observar`, FALSE, `call.ready_to_answer`, sin corte |
| Amenaza directa, herramienta endCall deshabilitada solo para aislar el corte del backend | 2217 ms | 2698 ms | TRUE, `alertar`, orden de corte y control Vapi aceptado |

La lectura posterior de diagnósticos confirmó `hangup_status: confirmed` y `end_reason: provider_ended` en la prueba de corte del backend. El detector tardó 600 ms y comprensión 1010 ms en ese caso. No confundir esos tiempos de cómputo con toda la latencia de voz.

El primer perfil excesivamente agresivo interrumpió la frase de entrada; no se contabilizó como respuesta rápida válida. Se ajustaron los umbrales y la espera de cierre de turno. En 8 kHz, Scribe confundió «Yape» con «Yahoo» en una muestra: el resto de la amenaza permitió detectar riesgo, pero no se ha demostrado reconocimiento perfecto de nombres o marcas.

El objetivo de menos de 1500 ms **no se cumplió en estas dos pruebas de la ruta Vapi**. Los seis resultados inferiores a 1500 ms del ensayo de ElevenLabs Agents no se extrapolan a esta orquestación ni a llamadas celulares.

## Prueba real

Otra persona llama al número de la SIM del Samsung desde un número no guardado. El modo automático de Tiskz abre su monitor y agrega al número de Vapi a la conferencia. No abrir un segundo monitor manual con autorización de corte, porque el servidor reserva un solo monitor de ese tipo.

Probar primero una petición cotidiana sin datos sensibles, comprobar transcripciones, porcentaje y `call.ready_to_answer`; después, una amenaza ficticia o una petición de códigos para comprobar `alertar` y el cierre de ambas patas en Android. No usar códigos reales ni conservar audio. Cada sesión Vapi del candidato tiene un máximo de 180 segundos.

Durante la prueba se observan estados, tiempos y confirmaciones de recepción. Las capturas privadas de configuración y los registros de metadatos están bajo `.maritime/cascade-phone/`, fuera de Git; no se guardan números de interlocutores ni transcripciones reales. Las transcripciones se procesan en memoria para la función de protección existente.

### Resultado de la conferencia real

La llamada real se completó con el candidato asignado, once turnos del interlocutor procesados y recepción comprobada en el Samsung. Los registros `TiskzPhone` confirmaron transcripciones finales de ambas voces, `risk.update`, comprensión, evaluación y `call.ready_to_answer`. El caso cotidiano pasó a `observar` con alerta FALSE. Esto permite invitar al usuario a entrar; no verifica la identidad de quien llama.

El usuario confirmó que dijo la amenaza ficticia de prueba. El detector pasó a TRUE / `alertar` en 578 ms desde el inicio de su inferencia sobre la transcripción recibida. La APK recibió `call.hangup_requested`; después ambas SIM figuraron sin llamadas activas y Vapi informó la llamada finalizada. El backend registró `hangup_reason: risk_detected` y `hangup_status: confirmed`. El monitor se cerró al terminar la conferencia en Android. La comprensión de ese último turno quedó pendiente: no bloqueó el corte ya autorizado.

Las once confirmaciones de recepción de alertas tuvieron ida y vuelta de 217–384 ms. Este dato no mide cuándo la persona terminó de hablar ni el primer sonido del agente.

Vapi reportó siete medidas de latencia de voz por turno: 1064, 1879, 1786, 1771, 2103, 2483 y 1860 ms. Media: **1849,43 ms**; máximo: **2483 ms**. Solo una de siete estuvo por debajo de 1500 ms, por lo que el objetivo máximo solicitado sigue sin cumplirse en esta llamada real. El proveedor también registró dos interrupciones del asistente. Promedios por etapa: transcripción 774,71 ms, cierre de turno 272 ms, modelo 446,14 ms y voz 323,29 ms. Son las métricas del proveedor, no una medición independiente de reproducción en el teléfono.

La configuración de grabación y transcripción persistente sigue desactivada en el asistente. La API devolvió la transcripción vacía y el objeto de grabación sin archivos; no se descargó ni guardó audio de la llamada. El consumo reportado por Vapi fue USD 0,1393; no se compraron créditos ni se contrató un número durante este ensayo.

Referencia para interpretar las etapas: [latencia de voz en Vapi](https://docs.vapi.ai/assistants/model-intelligence/understanding-latency) y [métricas de la llamada](https://docs.vapi.ai/observability/logs/call-logs).

## Restauración

La configuración previa se guardó de forma privada antes del cambio. Para volver a la ruta anterior, reasignar el número al asistente `6e1222f5-fcec-4fa3-b2f0-3471190937de`, restaurar ese mismo `VAPI_ASSISTANT_ID` y `VAPI_LIVE_MCP_ENABLED=true`, y reiniciar el agente. No reactivar el puente SIP fallido ni sobrescribir secretos, otros ajustes o el runtime al restaurar estas dos variables.

Fuentes: [Scribe en Vapi](https://docs.vapi.ai/providers/transcriber/elevenlabs), [voz ElevenLabs en Vapi](https://docs.vapi.ai/providers/voice/elevenlabs), [configuración de turnos](https://docs.vapi.ai/customization/voice-pipeline-configuration), [transporte de pruebas](https://docs.vapi.ai/calls/websocket-transport).

## Limpieza y comportamiento del asistente (18 de octubre de 2026)

Se actualizó el mismo asistente telefónico de Vapi, sin cambiar la ruta del número: `backgroundSpeechDenoisingPlan.smartDenoisingPlan.enabled=true` y `fourierDenoisingPlan.enabled=false`. Krisp ofrece activación/desactivación; no se configuró una supuesta intensidad suave. Se conserva Scribe v2 Realtime en español y la voz Sarah. La prueba aislada con una grabación autorizada no demostró una mejora de reconocimiento con Krisp; su activación es un ajuste para validar en llamadas reales, no una garantía de precisión. Los audios y resultados reales permanecen fuera de Git.

El prompt indica que el saludo inicial lo reproduce `firstMessage` una sola vez y que no debe repetirse en turnos posteriores. El papel es atender por cuenta del usuario, con respuestas breves y sin presentaciones espontáneas como IA ni frases de atención al cliente. Si preguntan directamente si es IA, responde con sinceridad. No asume el nombre del usuario ni finge serlo. Se evita pedir una ficha y volver a preguntar el motivo cuando el recado está completo.

En una prueba aislada de seis turnos ficticios, el modelo no generó nuevos saludos, recordó la corrección de las cuatro a las cinco y se presentó como quien atiende por cuenta del usuario. Persistieron algunas preguntas innecesarias y recapitulaciones: la naturalidad no se considera resuelta por completo. La herramienta de pruebas inyecta texto y no valida la experiencia de una conferencia física. Sus tiempos de captions no sirven como medición de latencia de respuesta.

Se observó retraso al incorporar al historial la transcripción de la propia voz del asistente. El primer ensayo con `modelOutputInMessagesEnabled=true` quedó inconcluso porque el capturador esperaba un caption inicial que no recibió. Se corrigió esa espera y se verificaron cinco turnos: el historial avanzó en pares usuario/agente, conservó la corrección de hora y el agente respondió al rol sin recitar el recado anterior. Ese modo se activó posteriormente, junto con el soporte de captions descrito abajo.

Se verificó que webhook, mensajes del servidor, transcriptor, voz, monitor, artefactos, saludo inicial y tiempos de turnos conservaran su configuración previa. Las alertas y el corte siguen a cargo del backend y de la APK. El almacenamiento de grabaciones del proveedor permanece desactivado. `npm test`: 109 pruebas aprobadas.

## Contexto secuencial y rol de sistema

El rol permanece en `model.messages` con `role: system`. Se activó `modelOutputInMessagesEnabled=true`: el contexto de la llamada usa directamente la respuesta generada en vez de volver a transcribir la voz del propio agente. Esto corrige el desfase observado en las pruebas controladas; no corrige las palabras mal reconocidas del llamante. El historial es de la sesión en curso y las opciones de artefactos persistentes siguen desactivadas.

Vapi deja de emitir los captions del agente por el camino acústico anterior en este modo. El puente acepta sus mensajes `conversation-update` con origen `model` o `force-say` y tiempo verificable, los ordena por turno y conserva el mismo contrato WebSocket para la APK. Ignora instantáneas atrasadas. El texto generado lleva `spoken_verified:false`: no prueba qué alcanzó a oír la otra persona si hubo una interrupción. Las palabras del llamante siguen entrando desde los finales de Scribe; no se reconstruyen desde resúmenes ni desde la voz del agente.

Se publicaron únicamente los cambios de `phone-bridge.mjs` sobre el paquete de producción existente; no se reemplazó el resto del servidor. Runtime previo: `d6940cb00b6cac5cfb0c95c1a0673c399c3e752fd476b5523b52353510f76373`. Runtime actualizado: `f47d7bef21c368411df6869d87b86b6c86d2de5836e595378d693ce4487acdc6`.

Validación local: 112 tests, incluyendo orden de ambas voces, deduplicación de instantáneas atrasadas y exclusión del texto generado del detector. Evaluación de continuidad con ejemplos ficticios en `eval/results/continuidad-voz-2026-10-18.json`. La reproducción del audio autorizado conservó los mismos finales de Scribe al cambiar el origen del historial: no se atribuye una mejora de reconocimiento a este ajuste.

Comprobación publicada: `andes-voz` activo y `/chat` responde. En una sesión de audio ficticio por Vapi → Maritime → el canal WebSocket usado por la APK se recibieron captions con fuentes `vapi_transcript_final` (llamante), `vapi_first_message` y `vapi_assistant_model_output` (agente), alerta FALSE y `call.ready_to_answer`. El proveedor confirmó la sesión terminada. Esta comprobación no sustituye la conferencia PSTN en un teléfono físico.
