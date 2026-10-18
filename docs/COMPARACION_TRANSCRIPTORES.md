# Comparación de reconocimiento de voz telefónica

18 de octubre de 2026. Ensayo aislado del mismo audio autorizado, sin cambiar el asistente asignado al número. Las sesiones WebSocket reprodujeron PCM mono de 16 kHz a ritmo real. Todos los candidatos usaron Krisp activado, Fourier desactivado y artefactos persistentes de Vapi desactivados. La respuesta sintetizada no se volvió a introducir al micrófono. No se incluyó la referencia del usuario en las instrucciones del transcriptor.

## Resultado observado

| Motor solicitado | Petición de dinero | Referencia al secuestro de la familia | Cierre urgente |
| --- | --- | --- | --- |
| Scribe v2 Realtime | Alteró el verbo | No conservó la palabra crítica | Introdujo frases ajenas a la referencia |
| Deepgram Nova-3, es-419 | Cambió el tiempo verbal | Reconoció el secuestro, alteró el sujeto y número | Reconoció la urgencia |
| Deepgram Flux multilingual | Conservó la petición | No conservó la palabra crítica | No conservó la expresión |
| Soniox stt-rt-v5 | Conservó la petición | Conservó la frase crítica | No conservó la expresión |

Esta revisión compara unidades de significado con la referencia recordada por el usuario. No es un WER ni una medición de precisión general: la referencia tiene omisiones y no está alineada palabra por palabra. Las muestras, transcripciones y referencia permanecen en el directorio privado de diagnósticos, fuera del repositorio. La tabla identifica la configuración solicitada. La facturación y configuración de la muestra Soniox confirmaron `provider: soniox`, `model: stt-rt-v5`; no se atribuye el resultado a un proveedor alternativo oculto.

Soniox base conservó las dos expresiones críticas en dos reproducciones del audio autorizado. Las regresiones sintéticas completadas conservaron la negación de pagos/códigos, el relato de una amenaza pasada y la corrección de 500 a 50. La prueba de cantidades siguió confundiendo Yape y puntuando mal. Los ejemplos ficticios y resultados están en `eval/results/transcripcion-regresiones-2026-10-18.json`. Hubo intentos fallidos de conexión, varios después de crear la sesión y antes de abrir el audio: no se cuentan como errores de reconocimiento ni como pruebas completadas.

Se activó el perfil base en el asistente existente `2bccff10-dfc6-4ea4-a235-f254830111f4`, ahora llamado `Tiskz - Soniox GPT Sarah`. La lectura posterior confirmó el cambio y la conservación de voz, prompt, contexto generado, webhook, eventos, monitor y opciones de artefactos. Se comprobó que no hubiera llamadas activas antes del cambio. No se modificó el servidor ni se reinstaló la APK.

## Precisión y latencia

Se rechazó un segundo perfil Soniox con cierre más agresivo y filtro de confianza: omitió una palabra crítica que el perfil base conservaba. Se cambiaron varios parámetros a la vez; el ensayo no permite atribuir el fallo a uno solo. No habilitar ese perfil para reducir la espera.

También se probó un perfil con vocabulario peruano neutral (Yape, Plin, BCP, SUNAT y soles). Recuperó Yape y conservó negaciones y relato, pero perdió una palabra crítica en la grabación autorizada. No se aplicó este perfil. Una reproducción no demuestra que el vocabulario cause ese error; sí impide asumir que la mejora de marcas justifica sustituir el perfil base.

El último final llegó 515 ms después del final del archivo con Scribe, 408 ms con Nova-3, 331 ms con Flux y 1445 ms con Soniox base. Estos intervalos incluyen silencios presentes en el archivo y **no miden la latencia desde el fin del habla hasta oír la respuesta**. No validan el objetivo de responder en menos de 1500 ms. Soniox puede añadir espera; debe medirse en la conferencia real antes de prometer una mejora de fluidez.

## Configuración aplicada y verificación

`config/vapi-soniox-transcriber.trial.json` contiene únicamente el parche del transcriptor aplicado. La configuración completa revisable sigue en `config/vapi-cascade-assistant.json`. Mantiene español estricto y no configura un filtro que descarte finales de baja confianza. La documentación de Vapi indica que ese filtro descarta transcripciones completas según su confianza media; no corrige sus palabras.

Procedimiento reproducible para futuras modificaciones:

1. Ejecutar `python3 scripts/evaluar-transcriptores.py --providers soniox --cases negacion,relato,cantidad --concurrency 1` y revisar que preserve negaciones, relato frente a amenaza presente y corrección de cantidades.
2. Leer el asistente actual y comprobar que no haya una llamada en curso. Conservar una copia privada de la configuración y aplicar solo `transcriber`; preservar voz, contexto generado, webhook, eventos, monitor y ajustes de conservación.
3. Comprobar transcripción del llamante, texto del agente, porcentaje, invitación a entrar y orden de corte en el canal existente de la APK con ejemplos ficticios.
4. Medir el fin del habla y el primer audio de respuesta en una conferencia real. Si no mejora el compromiso entre significado y espera, restaurar el transcriptor previo.

Comprobación con audio ficticio de 8 kHz por Vapi → Maritime → el WebSocket usado por la APK: texto del llamante completo, captions del agente, alerta FALSE, estado `observar` y `call.ready_to_answer`. Primer audio de respuesta a los 1673 ms desde el fin de la muestra y alerta a los 1889 ms. No hubo audio de respuesta antes de terminar la frase. Son medidas de una sesión sintética, sin red celular; el objetivo máximo de 1500 ms todavía no se cumple en esta prueba.

La amenaza ficticia conservó monto, Yape, amenaza a la familia y petición de secreto. Produjo TRUE, estado `alertar` y `call.hangup_requested`; Vapi aceptó el control de corte, el proveedor terminó la sesión y el diagnóstico posterior registró `hangup_status: confirmed`. La herramienta `endCall` del LLM estaba desactivada solo en ese ensayo para comprobar el camino del backend. Respuesta de voz: 1855 ms; alerta: 2496 ms desde el fin de la muestra. No se midió el cierre de las patas de una conferencia Android física. El arranque de esa sesión tuvo demora de conexión, por lo que tampoco se considera resuelto el tiempo de entrada de llamadas.

No se requiere MCP para reconocer las palabras. El transcriptor entrega finales a Vapi y al puente existente; comprensión y detección analizan esos finales. No reescribir la transcripción literal con un LLM para que encaje con una sospecha. Un resumen interpretado debe permanecer separado del texto reconocido.

Fuentes: [Soniox en Vapi](https://docs.vapi.ai/providers/transcriber/soniox), [contexto de Soniox](https://soniox.com/docs/stt/concepts/context).
