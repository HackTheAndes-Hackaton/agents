# Llamadas telefónicas con Vapi y marin

El número de Vapi tiene asignado `Tiskz - Entel marin prueba`, con `gpt-realtime-2` y voz `marin`, con procesamiento nativo de audio. La configuración histórica de GPT-4o Transcribe no gobierna la escucha del modelo Realtime; modificarla no garantiza mejorar sus subtítulos. La voz usa saldo de Vapi. La comprensión y la detección usan los modelos ya configurados en Maritime. No se ha configurado ni confirmado el desvío de Entel.

El asistente se identifica como virtual, informa del procesamiento con IA y solicita continuar. La prueba limita las llamadas a 180 segundos. `config/vapi-assistant.json` contiene la configuración sin credenciales: grabación, PCAP, logs de conversación e historial de transcripción desactivados. Esto no equivale a contratar el servicio Zero Data Retention del proveedor: Vapi puede conservar registros de entrega de webhooks aunque los logs de conversación estén desactivados.

## Alertas en Android

En «Voz en vivo», activar «Recibir alertas de llamadas que atiende Vapi», introducir el canal HTTPS y el código privado existente, autorizar el análisis y pulsar «Conectar alertas». Mantener abierta la pantalla durante la llamada. No se solicita permiso de micrófono para este modo. Detener las alertas no termina la llamada de Vapi.

El backend recibe `transcript` final del interlocutor, `conversation-update`, `status-update` y `end-of-call-report` en `POST /v1/phone/vapi`, autenticados con `X-Vapi-Secret`. Requiere `VAPI_WEBHOOK_SECRET`, `VAPI_ASSISTANT_ID` y opcionalmente `VAPI_PHONE_NUMBER`. El secreto pertenece solo a esta integración; no se comparte el código maestro de la app con Vapi.

`POST /v1/phone/monitor` exige `X-Voice-Token` y `consentimiento_analisis: true`. Devuelve un ticket que vence a los 60 segundos y se consume una sola vez en `/ws/calls?channel=phone&ticket=...`. El proxy público no conserva las cabeceras privadas durante el upgrade WebSocket. El código privado no se incluye en URLs.

Se analiza una llamada a la vez, solo mientras hay observadores autorizados. Se descartan subtítulos parciales. Los turnos finales se ordenan por la marca temporal del proveedor. Se usa un solo formato de eventos por llamada para no duplicar frases; también se admiten snapshots completos. Se conservan las negaciones, se excluye la voz del asistente y se descartan duplicados y eventos antiguos. Cada llamada tiene sus propias revisiones. Los fallos no generan FALSE. La app borra la decisión y las evidencias anteriores al empezar otra llamada. El backend descarta el contenido al terminar o desconectar el último observador; no se escribe historial en disco.

## Modelos de voz

La conversación por internet dentro de la app conserva GPT-Live 1 a través de Maritime. El número telefónico usa GPT Realtime 2 en Vapi (0.4.2): las pruebas de GPT-Live por WebSocket recibieron audio marin, pero no entregaron transcripciones al servidor durante la llamada. Realtime Mini y GPT Realtime 2 sí entregaron eventos en vivo. Esto describe la ruta comprobada; no demuestra que todas las conexiones GPT-Live tengan esa limitación.

## Verificación

Verificación anterior (antes de 0.4.2): 35 pruebas del backend y 19 pruebas unitarias Android correctas; compilación y lint Android correctos. Dos llamadas con audio sintético contra Vapi y el backend desplegado: amenaza TRUE y reunión con negación de pagos FALSE. Se recibió audio marin y comprensión con citas literales, sin identidades atribuidas, y ambas llamadas terminaron. Los dos casos finales consumieron US$0,0644 del saldo de Vapi; no es una tarifa por minuto ni incluye las pruebas de diagnóstico anteriores.

## Límites de la verificación

Una prueba de voz por WebSocket valida el modelo y el recorrido de eventos, pero no demuestra recepción PSTN ni un desvío desde Entel. El número de prueba es estadounidense. La compatibilidad y la tarifa del desvío internacional dependen de Entel y no se infieren de que Vapi entregue un número gratis. El botón de ajustes de desvío de Android no activa el servicio automáticamente.

Fuentes: [Vapi Realtime](https://docs.vapi.ai/openai-realtime), [Vapi GPT-Live](https://docs.vapi.ai/gpt-live/configuration), [números gratuitos](https://docs.vapi.ai/free-telephony), [eventos](https://docs.vapi.ai/server-url/events), [autenticación](https://docs.vapi.ai/server-url/server-authentication), [precios](https://vapi.ai/pricing).


## Corte automático por riesgo (APK 0.4.2)

El monitor nuevo solicita `consentimiento_corte_automatico: true`. Se admite un solo monitor de corte y no se vincula a una llamada que ya estaba activa. Los clientes anteriores siguen siendo observadores: mostrar una alerta no los autoriza a colgar.

Cuando una detección vigente devuelve TRUE, Maritime emite `call.hangup_requested` con `session_id`, `call_id`, `request_id`, `revision` y `reason: risk_detected`. La conferencia administrada por Tiskz valida esa orden y solicita a Android desconectar el padre y las dos patas. Maritime envía también `end-call` al control privado de Vapi. La clave `VAPI_API_KEY`, si está configurada, permite recuperar ese control desde el ID verificado de la llamada; nunca se envía a la APK.

`call.hangup_result` distingue `requested`, `already_ended` y `failed`. Una respuesta HTTP de control aceptada no demuestra que Entel haya cortado: `status-update: ended` confirma Vapi y los callbacks Telecom confirman el teléfono. Si la conferencia se creó manualmente fuera de Tiskz, el backend solo puede cerrar la parte de Vapi.

FALSE, errores, parciales de Vapi, voz del agente y resultados obsoletos no disparan el corte. El cierre es preventivo; no atribuye una identidad ni confirma fraude. El modo automático de conferencia y la confirmación de costos siguen apagados por defecto.

El saludo es «Hola, ¿qué necesitas?». Se usa conversación breve y cotidiana, aclaración de cantidades o palabras dudosas y ninguna aceptación de pagos o compromisos. Si se pregunta directamente, identifica con honestidad la voz de IA; no suplanta al titular. Las transcripciones se muestran literalmente; no se reescriben para hacerlas parecer correctas.


El canal telefónico usa `gpt-realtime-2` con marin para la prueba de calidad. Se probó GPT-Live 1 por el transporte WebSocket de Vapi: produjo voz y subtítulos en el cliente, pero no entregó las transcripciones en vivo al webhook de Maritime en esas pruebas. No se publica esa migración porque dejaría sin análisis preventivo este flujo. GPT-Live 1 del canal WebRTC directo es independiente.

Para reducir interpretaciones prematuras, la configuración telefónica se suscribe a `transcript`, filtra `transcriptType: final` en el servidor y excluye `conversation-update`. Los subtítulos de marin se muestran con su propio hablante y nunca se usan como evidencia del interlocutor. El diagnóstico autenticado `GET /v1/phone/diagnostics` informa si llegaron eventos, si corresponden al asistente y si hubo orden de corte; no devuelve audio, transcripción, teléfono ni claves.

Verificación 0.4.2: 50 pruebas Node y 51 Android correctas, APK debug compilada. Dos llamadas de audio sintético con GPT Realtime 2: amenaza TRUE con orden de corte aceptada y fin confirmado por Vapi; reunión FALSE sin orden de corte, finalizada por el cliente de prueba. La negación de pagos se transcribió literalmente, mejor que Mini en esta muestra. En la amenaza persistió una palabra mal reconocida: no se afirma una transcripción perfecta ni una mejora general medida. Las dos llamadas finales consumieron US$0,1804 de Vapi; esto no es una tarifa por minuto ni incluye diagnóstico anterior. El saldo de Maritime se usa para los análisis, no para esa voz. El cierre de la conferencia en Entel aún requiere validación física.
