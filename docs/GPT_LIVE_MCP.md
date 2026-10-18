# GPT-Live 1 y herramientas de llamada

Implementación candidata y desactivada por defecto. Conserva el número y asistente de producción hasta una activación explícita. No demuestra todavía una mejora de comprensión o latencia: las pruebas locales usan entradas ficticias y modelos simulados.

## Conversación y acciones

`config/vapi-live-assistant.template.json` configura GPT-Live 1 con marin y un reasoner de Vapi que usa cuatro herramientas MCP. La conversación continúa mientras trabaja el reasoner. Los agentes de detección y comprensión existentes se ejecutan en Maritime cuando llega `evaluar_conversacion`; devuelven orientación al reasoner y publican los eventos habituales para la APK. No se delegan saludos o aclaraciones simples.

El speaker y el reasoner tienen instrucciones separadas: conversación breve en español peruano, una pregunta por turno, prioridad a correcciones, aclaración de cifras/negaciones, ninguna identidad verificada por voz o nombre, ningún compromiso económico ni petición de credenciales. Yape, BCP, SUNAT, familiaridad o euforia son contexto; no constituyen por sí solos una alerta. Las reglas específicas de detección existentes continúan evaluando cada reporte.

## MCP autenticado

`POST /v1/phone/live/mcp` implementa inicialización, descubrimiento y ejecución mediante Streamable HTTP stateless. Requiere `X-Tiskz-Live-Secret`, distinto del código de la APK. Vapi suministra `X-Call-Id`. El backend valida ese ID y su asistente con la API de Vapi, exige un monitor autorizado y evita mezclar llamadas. La verificación se reutiliza durante cinco segundos; al cerrar la llamada se borra. No se expone ninguna credencial a la APK.

- `evaluar_conversacion`: recibe texto acumulado del interlocutor, ficha de citas, `revision_previa` y `request_id`; `ficha` es opcional y solo se admite por compatibilidad. Ejecuta ambos análisis y devuelve orientación. La primera evaluación usa revisión 0; después reutiliza la revisión devuelta y consulta estado solo ante un conflicto. Una corrección exige un nuevo request_id. Los reintentos idénticos reutilizan el resultado; una clave reutilizada con otro texto se rechaza. Una revisión antigua no reemplaza una nueva.
- `consultar_estado`: devuelve orientación y revisión actuales sin repetir inferencias. Pendiente o inconcluso no significa ausencia de riesgo.
- `solicitar_corte`: requiere alerta vigente y autorización del monitor de la APK. La detección urgente sigue publicándose y solicitando corte sin esperar a comprensión.
- `finalizar_por_peticion`: requiere una cita literal completa de la última intervención del interlocutor, una fórmula explícita de despedida/cierre, revisión vigente y permiso de corte. «No me cortes», una palabra aislada, una despedida anterior o un cierre citado dentro de otra frase no autorizan colgar. Las fórmulas no reconocidas requieren aclaración.

El candidato no añade `endCall` como herramienta independiente: así el modelo no puede saltarse estos controles de cierre. `requested` confirma la solicitud, no la desconexión. El webhook autenticado de fin del proveedor sigue confirmando el cierre.

## Invitación para incorporarse

El agente usa lo ya dicho y pregunta solo por una ambigüedad relevante. Nombre, entidad y una ficha completa no son requisitos para analizar, alertar ni invitar al titular. La ficha opcional contiene únicamente citas literales, nunca identidad verificada. Tras obtener `observar` sin alerta se publica `call.ready_to_answer`, con `identity_verified: false`. Un saludo o una presentación sin contenido suficiente dejan `inconcluso`; una petición cotidiana interpretable puede avanzar. Las acciones sensibles exigen `verificar` y una petición todavía sin clasificar queda `inconcluso`. Cada nueva intervención invalida la invitación anterior y se vuelve a evaluar: incorporarse no desactiva la revisión ni garantiza seguridad. La APK conserva sus controles y notificaciones locales.

## Límite importante de transcripción y evidencia

GPT-Live en Vapi no proporciona el socket de escucha que utiliza la integración actual de Scribe y los fragmentos de audio. El servidor impide habilitar este modo con Scribe paralelo o captura de evidencia activados, en lugar de perder esas funciones silenciosamente. El estado de las herramientas indica `audio_evidence: unavailable_in_vapi_live`.

Para recibir contexto por MCP, el reasoner reporta el texto que entiende del interlocutor. Ese texto se etiqueta `live_reasoner_report_not_audio_verified`, se publica como provisional y no se presenta como ASR independiente. El servidor comprueba las citas contra ese reporte, no contra el audio original. Se rechaza la instrucción interna de delegación observada durante el ensayo en lugar de atribuírsela al interlocutor; esto no detecta todas las posibles contaminaciones. El modelo podría omitir una intervención, reportarla mal o no llamar a una herramienta: **este modo no garantiza cobertura continua de detección**. El contrato de la APK debe conservar visible esta distinción antes de usarlo fuera de pruebas.

Antes de sustituir producción, hay que comprobar con voz real tanto el transporte del número como la conservación de cantidades/negaciones, las correcciones, la frecuencia de delegación, el tiempo de respuesta y la entrega de alertas. Si se requiere Scribe independiente o conservación de audio en el mismo flujo, hace falta una pasarela con acceso al audio original; cambiar únicamente `model.model` no conserva esas capacidades. El diseño no elimina el tiempo de marcado y unión de la conferencia de la SIM.

## Preparación sin publicación

En una ruta de servidor privada, configurar `TISKZ_LIVE_MCP_URL` con HTTPS y ruta `/v1/phone/live/mcp`, además de `VAPI_LIVE_MCP_SECRET` y `VAPI_WEBHOOK_SECRET`. Ejecutar:

```sh
node scripts/preparar-vapi-live.mjs /ruta/privada/candidato.json
```

El archivo contiene secretos, se crea con permisos 0600, no se sobrescribe y nunca debe entrar en Git. El script no llama a Vapi ni publica cambios. La plantilla en Git usa marcadores, no credenciales.

Para una prueba aislada del servidor, usar `VAPI_LIVE_MCP_ENABLED=true`, `VAPI_LIVE_MCP_SECRET`, `VAPI_API_KEY`, el `VAPI_ASSISTANT_ID` del candidato y el secreto de su webhook. Scribe y captura deben estar explícitamente apagados para este candidato. No cambiar el asistente del número ni recargar un servidor compartido durante una llamada. El modo Realtime existente y sus funciones permanecen disponibles al mantener `VAPI_LIVE_MCP_ENABLED=false`.

## Validación local

`npm test`: 106 pruebas aprobadas, incluidas autorización, revisiones, reintentos, correcciones, invitación a entrar y cortes confirmados. El paquete comprimido arranca y responde a `/health` con ambos modos, y el catálogo MCP solo está disponible al habilitarlo. El arranque del paquete se comprobó con red externa bloqueada. Estas verificaciones locales usan datos ficticios y no miden calidad de voz ni latencia de Vapi.

## Ensayo desplegado el 18 de octubre de 2026

Por autorización explícita para reemplazar la configuración, el candidato está habilitado temporalmente en `andes-voz`, con el canal HTTPS y el código de la APK conservados. El número existente apunta al asistente candidato `6e1222f5-fcec-4fa3-b2f0-3471190937de`. No se creó otra VM ni otro número. La configuración anterior y el procedimiento de restauración están bajo `.maritime/live-trial-20261018/`, excluidos de Git; contienen secretos y no deben compartirse.

La habilidad `revision-llamada` expone al speaker el propósito del análisis, incluidas las respuestas aparentemente normales, y deja el procedimiento y las herramientas al reasoner. Después de añadirla, las dos últimas llamadas sintéticas por WebSocket entregaron análisis: una amenaza produjo `alertar`, orden de corte y cierre confirmado por Vapi; el caso normal conservó la negación de pedir dinero, devolvió alerta falsa y no se cortó. Ese caso quedó en `verificar`, por lo que **no produjo `call.ready_to_answer`**. No se ha validado este flujo en una conferencia celular real.

En esas dos muestras, el primer audio llegó aproximadamente 5,3 y 4,9 segundos después de iniciar el cliente de prueba; las alertas llegaron 6,4 y 6,1 segundos después del audio de entrada. Incluyen conexión y delegación, no son una medida aislada del modelo ni prueban una mejora frente a la ruta anterior. Hubo intentos previos sin delegación y uno con contenido interno en el reporte; no se afirma cobertura continua ni calidad general demostrada. La configuración conserva el límite de 180 segundos, sin grabación, Scribe ni captura de fragmentos.

Fuentes: [GPT-Live en Vapi](https://docs.vapi.ai/gpt-live/configuration), [herramientas y reasoner](https://docs.vapi.ai/gpt-live/tools), [MCP y cabecera X-Call-Id](https://docs.vapi.ai/tools/mcp). El patrón de separación de audio/delegación se contrastó con los repositorios de Reevalua; no se copiaron código, datos, memoria ni credenciales de esos proyectos.

## Corrección progresiva publicada después del ensayo

La rama elimina el formulario obligatorio y añade las categorías `saludo`, `presentacion`, `solicitud_cotidiana` y `relato_amenaza`, con selección por citas literales. Mantiene separados una petición de dinero, una amenaza ejercida y un relato de amenaza recibida. Una solicitud genérica sin clasificar exige aclaración, sin equipararla automáticamente a una solicitud sensible. La alerta vigente continúa pudiendo solicitar corte antes de que termine comprensión.

La corrección pasó 106 pruebas locales y siete casos de texto con los modelos reales desde Maritime. Se activó el runtime `d6940cb00b6cac5cfb0c95c1a0673c399c3e752fd476b5523b52353510f76373` y se actualizaron las instrucciones del asistente candidato conservando voz, número, claves y canal. La evaluación usa casos de desarrollo, una muestra por caso; no mide reconocimiento de voz ni rendimiento general. El corpus está en `eval/conversacion-progresiva-v1.json` y el resultado en `eval/results/conversacion-progresiva-2026-10-18.json`. No se afirma que esta rama restablezca Scribe ni una transcripción continua independiente. Véase [el contrato propuesto de transcripción y porcentaje](TRANSCRIPCION_Y_ALERTA_CONTINUA.md).
