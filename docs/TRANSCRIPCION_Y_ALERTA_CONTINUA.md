# Transcripción y porcentaje durante la llamada

## Objetivo

Mantener dos recorridos en paralelo: audio a la conversación de voz, y audio o subtítulos del proveedor al análisis preventivo. El detector recibe cada intervención confirmada sin depender de que el agente decida invocar una herramienta. MCP consulta orientación y solicita acciones verificadas; no reemplaza la fuente de transcripción.

La APK muestra texto parcial conforme llega y reemplaza ese parcial por el final del mismo turno, sin reescribir palabras, completar nombres ni atribuir identidad. El análisis usa finales o segmentos confirmados que conservan negaciones y contexto. Analizar cada fragmento parcial podría cortar por una frase que aún no terminó de negarse o corregirse.

## Contrato de eventos conservado

- `transcript.update`: ID estable por turno, `speaker`, `sequence`, `text`, `final`, `revision` y `source`. Distinguir entrada de llamada y voz del agente no identifica a las personas de una conferencia.
- `alert.updated` y `risk.update`: resultado de la revisión actual, porcentaje de 0 a 100 y estado provisional. Es la estimación del detector sobre la necesidad de alerta, no una probabilidad calibrada de delito o de identidad fraudulenta. Puede bajar después de una corrección.
- `assessment.update`: observar, verificar, alertar o inconcluso. Un error no se convierte en FALSE ni en 0 %.
- `call.ready_to_answer`: invitación provisional después de revisar el contexto disponible, sin datos personales obligatorios ni identidad verificada. La siguiente intervención invalida la invitación anterior.
- `call.hangup_requested` y `call.hangup_result`: conservan permiso de corte, revisión vigente y confirmación separada del proveedor y Android.

Transcripción y porcentaje son eventos separados. La pantalla puede mostrar el texto nuevo mientras el análisis de ese turno sigue pendiente. No se deben animar porcentajes inventados entre resultados ni publicar un resultado atrasado sobre una revisión nueva.

## Situación del candidato GPT-Live en Vapi

El candidato actual recibe por MCP un reporte del modelo, etiquetado `live_reasoner_report_not_audio_verified`; muestra texto y porcentaje al evaluarlo, pero no garantiza cobertura continua ni equivale a la transcripción independiente anterior. Scribe y captura de audio siguen deshabilitados en este modo.

Se probó una llamada aislada suscribiendo `transcript` en `serverMessages`: hubo subtítulos del interlocutor y del agente en el cliente, pero no se observaron mensajes `transcript` en el webhook ni subtítulos del agente en el monitor. Esa muestra no habilita una fuente continua para producción. Recibir subtítulos en el cliente WebSocket no demuestra que se entreguen al servidor. Si se confirma la entrega, esa fuente puede alimentar directamente al detector y la APK, y MCP dejaría de introducir el texto de análisis. Si no se confirma, hace falta una pasarela con acceso al audio original para transcribir en paralelo, o conservar una ruta que ya proporcione ese audio. Vapi documenta que GPT-Live no ofrece sockets de escucha en vivo; no debe darse por disponible Scribe solo por cambiar una configuración.

La pantalla y las alertas no dependen de recopilar nombre, entidad, motivo y petición como formulario. El micrófono local de la conferencia se mantiene silenciado hasta que el titular entra; este contrato no cambia ese control.

## Verificación necesaria

Medir por separado final del audio, final de transcripción, recepción del texto por el backend, resultado del detector, envío por WebSocket y acuse de la APK. Comparar el texto con audio autorizado antes de afirmar mejoras de reconocimiento. Probar solicitud cotidiana, préstamo sin coacción, amenaza directa con exigencia de dinero, códigos bancarios, negación, corrección y relato de amenaza recibida. Comprobar tanto la conversación como los eventos y el cierre real; una prueba del transporte WebSocket no demuestra la conferencia celular.

Fuentes: [compatibilidad de GPT-Live](https://docs.vapi.ai/gpt-live/configuration), [herramientas y delegación](https://docs.vapi.ai/gpt-live/tools), [pruebas y latencia](https://docs.vapi.ai/gpt-live/testing).
