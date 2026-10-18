# Llamadas telefónicas con Vapi y marin

El número de Vapi tiene asignado `Tiskz - Entel marin prueba`, con `gpt-realtime-mini-2025-12-15` y voz `marin`, y GPT-4o Transcribe configurado en español (`es`). La voz usa saldo de Vapi. La comprensión y la detección usan los modelos ya configurados en Maritime. No se ha configurado ni confirmado el desvío de Entel.

El asistente se identifica como virtual, informa del procesamiento con IA y solicita continuar. La prueba limita las llamadas a 180 segundos. `config/vapi-assistant.json` contiene la configuración sin credenciales: grabación, PCAP, logs de conversación e historial de transcripción desactivados. Esto no equivale a contratar el servicio Zero Data Retention del proveedor: Vapi puede conservar registros de entrega de webhooks aunque los logs de conversación estén desactivados.

## Alertas en Android

En «Voz en vivo», activar «Recibir alertas de llamadas que atiende Vapi», introducir el canal HTTPS y el código privado existente, autorizar el análisis y pulsar «Conectar alertas». Mantener abierta la pantalla durante la llamada. No se solicita permiso de micrófono para este modo. Detener las alertas no termina la llamada de Vapi.

El backend recibe `transcript` final del interlocutor, `conversation-update`, `status-update` y `end-of-call-report` en `POST /v1/phone/vapi`, autenticados con `X-Vapi-Secret`. Requiere `VAPI_WEBHOOK_SECRET`, `VAPI_ASSISTANT_ID` y opcionalmente `VAPI_PHONE_NUMBER`. El secreto pertenece solo a esta integración; no se comparte el código maestro de la app con Vapi.

`POST /v1/phone/monitor` exige `X-Voice-Token` y `consentimiento_analisis: true`. Devuelve un ticket que vence a los 60 segundos y se consume una sola vez en `/ws/calls?channel=phone&ticket=...`. El proxy público no conserva las cabeceras privadas durante el upgrade WebSocket. El código privado no se incluye en URLs.

Se analiza una llamada a la vez, solo mientras hay observadores autorizados. Se descartan subtítulos parciales. Los turnos finales se ordenan por la marca temporal del proveedor. Se usa un solo formato de eventos por llamada para no duplicar frases; también se admiten snapshots completos. Se conservan las negaciones, se excluye la voz del asistente y se descartan duplicados y eventos antiguos. Cada llamada tiene sus propias revisiones. Los fallos no generan FALSE. La app borra la decisión y las evidencias anteriores al empezar otra llamada. El backend descarta el contenido al terminar o desconectar el último observador; no se escribe historial en disco.

## Modelos de voz

La conversación por internet dentro de la app conserva GPT-Live 1 a través de Maritime. El número telefónico usa Realtime Mini en Vapi: las pruebas de GPT-Live por WebSocket recibieron audio marin, pero no entregaron transcripciones al servidor durante la llamada. Realtime Mini sí entregó eventos en vivo. Esto describe la ruta comprobada; no demuestra que todas las conexiones GPT-Live tengan esa limitación.

## Verificación

35 pruebas del backend y 19 pruebas unitarias Android correctas; compilación y lint Android correctos. Dos llamadas con audio sintético contra Vapi y el backend desplegado: amenaza TRUE y reunión con negación de pagos FALSE. Se recibió audio marin y comprensión con citas literales, sin identidades atribuidas, y ambas llamadas terminaron. Los dos casos finales consumieron US$0,0644 del saldo de Vapi; no es una tarifa por minuto ni incluye las pruebas de diagnóstico anteriores.

## Límites de la verificación

Una prueba de voz por WebSocket valida el modelo y el recorrido de eventos, pero no demuestra recepción PSTN ni un desvío desde Entel. El número de prueba es estadounidense. La compatibilidad y la tarifa del desvío internacional dependen de Entel y no se infieren de que Vapi entregue un número gratis. El botón de ajustes de desvío de Android no activa el servicio automáticamente.

Fuentes: [Vapi Realtime](https://docs.vapi.ai/openai-realtime), [Vapi GPT-Live](https://docs.vapi.ai/gpt-live/configuration), [números gratuitos](https://docs.vapi.ai/free-telephony), [eventos](https://docs.vapi.ai/server-url/events), [autenticación](https://docs.vapi.ai/server-url/server-authentication), [precios](https://vapi.ai/pricing).
