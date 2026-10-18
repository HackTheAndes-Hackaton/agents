# Resumen automático de pruebas con Maritime o Grok

El canal de voz, la comprensión y la detección existentes continúan funcionando. El modelo se invoca al terminar una sesión autorizada: una consulta estructurada extrae identificadores y señales y redacta el resumen. Se usa `fetch` nativo, sin SDK, orquestador ni paquetes nuevos. Para esta cuenta se usará el saldo de IA de Maritime.

## Configuración del servidor

`npm start` carga `.env.local` si existe, además de las variables que ya aporte el despliegue. El archivo está ignorado por Git. Configurar:

```dotenv
TISKZ_REPORT_PROVIDER=maritime
TISKZ_REPORT_MODEL=gpt-4.1-mini
TISKZ_REPORTS_ENABLED=true
TISKZ_REPORTS_SIMULATED=true
TISKZ_API_URL=https://web-repo-xi.vercel.app/api/v1
TISKZ_API_KEY=
TISKZ_ORG_ID=org_uav
TISKZ_EVIDENCE_SIMULATED=true
```

Activar **Use Maritime LLM** en el agente para que Maritime inyecte `OPENAI_API_KEY` y `OPENAI_BASE_URL`. Ambas variables son necesarias: si falta la URL no se intenta enviar el token a OpenAI directamente. No hace falta una clave de xAI. Las llamadas descuentan el saldo de IA disponible, compartido con voz y otros análisis. Confirmar que el modelo esté disponible en el proxy antes de conectar clientes.

La clave del modelo y la clave de integración pertenecen al backend. La APK no las recibe. `TISKZ_API_KEY` es una clave de servicio creada en el panel de Integraciones. Mantener el origen de reportes y fragmentos consistente: estos ejemplos son exclusivamente pruebas ficticias. Conservar las demás variables de voz ya configuradas. No sustituir una configuración existente al añadir estas variables.

Para conservar la opción anterior: `TISKZ_REPORT_PROVIDER=xai`, `XAI_API_KEY` y `XAI_MODEL=grok-4.7`. Seleccionar proveedor es explícito; no se usan credenciales de un proveedor en otro. Los metadatos distinguen `maritime` de `xai` y el panel acepta ambos.

### Backend que llama al agente privado

El agente `tiskz-reportes` está en la cuenta de Natalia y tiene el proxy activado. Para un backend que se ejecute fuera de esa VM, configurar `TISKZ_REPORT_PROVIDER=maritime`, `TISKZ_REPORT_TRANSPORT=agent`, `MARITIME_REPORT_AGENT_ID=6e0be7be-1e37-468c-9ecd-1438e338e659` y `MARITIME_REPORT_API_KEY` como secreto de servidor. No reutilizar la clave del proxy fuera de su agente.

La credencial del cliente está en `.env.local` (ignorado por Git), tiene alcance `deploy` y caduca en 30 días. Este alcance también permite operaciones de ciclo de vida en la cuenta: conservarla exclusivamente en el backend. La respuesta remota se comprueba otra vez contra la transcripción de la sesión antes de persistir hallazgos. Los errores de transporte no se reintentan automáticamente, para no repetir una generación cuya respuesta pudo perderse.

`POST https://api.maritime.sh/api/agents/6e0be7be-1e37-468c-9ecd-1438e338e659/chat` requiere `Authorization: Bearer <credencial del backend>` y un objeto `{message: "<incidente JSON serializado>"}`. El incidente debe incluir `consentimiento_analisis: true`, `consentimiento_reporte: true` y `transcripcion`. La respuesta contiene `{response: "<reporte JSON serializado>"}`. No enviar esta credencial a la APK.

Estado verificado: servicio activo, una prueba ficticia completada con `gpt-4.1-mini-2025-04-14`, 573 tokens de entrada y 244 de salida (817 total). La prueba verifica inferencia; no acredita integración con el panel ni el canal de voz de otra cuenta. Para persistir automáticamente siguen siendo necesarias `TISKZ_API_KEY` y la publicación de la web compatible con el proveedor `maritime`.

## Pruebas desde el backend y permisos

Este paso modifica exclusivamente el backend y la web. La app móvil conserva su código y comportamiento actuales. Las pruebas ficticias se inician desde el backend con `consentimiento_reporte: true` en `POST /v1/sessions` o en la creación de un ticket de monitor. Son solicitudes autenticadas con el código de acceso existente. El permiso de análisis y el permiso de audio por sí solos no habilitan el reporte. La app actual no envía esa autorización y, por tanto, no activa esta generación.

Cuando una sesión WebRTC termina, el backend toma una instantánea del texto humano disponible y de la detección solo si corresponde a la última revisión. En Vapi usa el texto humano recibido por su webhook autenticado y el identificador de esa llamada. No deduce el número original de Android ni lo vincula a una conferencia por horario o parecido. El inicio de un reporte Vapi describe el primer evento observado por el monitor, no acredita el comienzo original de la llamada. Si el monitor se detiene antes, el contexto es parcial.

La voz del asistente queda fuera del resumen. El contexto literal se procesa en memoria y se envía a xAI como proveedor de IA autorizado; no se guarda en el panel ni en archivos de historial. No se envían clips de audio a Grok en este paso. Los datos del prompt son información no confiable; no habilitan herramientas ni búsqueda web.

## Persistencia y errores

Se reutiliza el ID determinista de la sesión que utiliza el almacenamiento de audio. El servicio comprueba organización, sesión, origen y compartición vigente antes de reutilizarlo; no crea una segunda copia por haber guardado un fragmento. Se conserva el permiso de audio existente y se registra la autorización separada del reporte.

El panel muestra generación `running`, `completed` o `failed` en `analysis_meta.report_generation`. La entrega final usa `POST /incidents/{id}/findings` del paso 1 y conserva proveedor, modelo, versión de prompt, límites y consumo informado por xAI. Un fallo no se transforma en llamada segura. Una pérdida de confirmación se comprueba antes de marcar como fallido un resumen que ya se guardó correctamente.

Los identificadores y sus metadatos de banco/billetera/moneda se contrastan con el segmento recibido que el modelo seleccionó. Se rechazan valores reconstruidos, segmentos inventados y salidas incompletas. Se guardan hashes y posiciones de origen, no la cita. Estas verificaciones no certifican la transcripción ni la veracidad del relato; la narración de Grok requiere revisión humana.

Grok tiene un máximo de dos intentos ante fallos temporales. La entrega HTTP tiene reintentos acotados con el mismo contenido y UUID. Los trabajos se ejecutan en el proceso existente, se deduplican por sesión y se esperan durante un cierre ordenado. No constituyen una cola durable: una interrupción abrupta puede dejar el incidente en `running`. No se conserva la transcripción para reanudarlo; esa recuperación se ampliará cuando sea necesaria fuera de la demo.

## Publicación y verificación

Publicar primero la web compatible con `analysis.generation` y después el backend con sus variables. No hay cambios ni publicación de APK en este alcance. No hacen falta migraciones. El generador de runtime existente incluye `reports.mjs` y `grok-report.mjs`; generar el paquete no publica ni actualiza una VM.

`npm test -- --test-concurrency=1` valida modelos y proveedores ficticios locales. La ejecución secuencial evita que los tickets de 80 ms de pruebas se agoten por concurrencia en Windows. Para comprobar la API real se usa una conversación ficticia pequeña y solo se informa estado, modelo y consumo, sin imprimir la clave o la conversación. Las pruebas locales no acreditan despliegue, telefonía física ni recepción de una denuncia.

`npm run test:report -- --mock` inicia una sesión local, inyecta exclusivamente el texto ficticio incluido en el script y la cierra. Comprueba el flujo hasta el payload de hallazgos con un proveedor simulado. `npm run test:report` repite el flujo con la API real de Grok y requiere `XAI_API_KEY`; consume tokens de esa cuenta. Ambas variantes usan almacenamiento temporal en memoria y no escriben en el panel remoto, ni llaman a telefonía o a los modelos de voz. La salida identifica si el proveedor fue simulado e incluye el resumen de prueba, modelo y consumo.
