# Cascada de voz de baja latencia

Ensayo aislado del 18 de octubre de 2026. Usa Scribe Realtime → modelo de texto con historial → Eleven Flash v2.5, voz Sarah. El candidato existente es `agent_6701m56yj6ehfwgbm8arhvvtnm6e`; no es marin y no modifica el número de Vapi ni el despliegue de Maritime. Las alertas, porcentaje y corte de la APK todavía no están conectados a este ensayo.

El objetivo solicitado es **menos de 1500 ms** entre el final del habla y el comienzo del audio de respuesta. No confundir con tiempo de conexión, saludo, recepción del texto o final de la respuesta. No contar una respuesta que interrumpe el audio de entrada como una latencia exitosa.

## Resultado medido

La variante seleccionada es **Scribe Realtime → GPT-4.1 mini → Eleven Flash v2.5 / Sarah**, en el candidato autenticado de ElevenLabs. Se verificó la configuración por lectura posterior. Se conservó el número Vapi en su ruta anterior.

| Caso ficticio | GPT, ronda 1 | GPT, ronda 2 |
| --- | ---: | ---: |
| Reunión, sin pagos ni códigos | 1313 ms | 1451 ms |
| Amenaza directa y pedido de 500 soles | 1452 ms | 1421 ms |
| Corrección de 500 a 50 soles | 1390 ms | 1456 ms |

Seis de seis mediciones cumplen el límite estricto de 1500 ms; el máximo observado fue 1456 ms, con solo 44 ms de margen. Son tres frases sintetizadas, repetidas dos veces, no seis muestras independientes de llamadas humanas. Esto no permite garantizar un máximo universal ni extrapolar a una conferencia celular. Métricas sin transcripciones reales en `eval/results/cascada-voz-2026-10-18.json`.

La configuración anterior con Gemini 2.5 Flash sin estos ajustes tardó 5408 y 5527 ms en los dos primeros casos. Con razonamiento desactivado y generación especulativa dio 1441, 1788 y 1084 ms: no cumplió en los tres. Flash Lite dio 1734, 2826 y 1342 ms y además inventó un horario; se descartó.

Las transcripciones GPT conservaron negaciones y la corrección de cantidades, normalizando los números a cifras. No hubo respuestas antes de terminar el audio de entrada. La respuesta a la amenaza en la primera ronda añadió «¿Quieres hablar de otra cosa?», una pregunta innecesaria: la prueba de latencia no acredita que el comportamiento de protección esté terminado. No emitir alertas ni cortar usando este prototipo como si ya estuviera integrado. Pasaron 109 pruebas automatizadas, incluidas las que impiden contar silencio, respuesta ausente, interrupción o resultados fallidos como éxito de latencia.

## Configuración

`config/elevenlabs-cascade-fast.trial.json` contiene la base, con respuestas breves, turnos `eager`, generación especulativa, razonamiento extendido desactivado, Flash v2.5 y sin mensajes de relleno. `turn_timeout: 7` es el máximo para volver a preguntar cuando el usuario no responde; no es una pausa fija de siete segundos después de cada intervención. `optimize_streaming_latency` no se usa: el esquema actual lo declara obsoleto y sin efecto.

Para la variante GPT, fusionar `conversation_config.agent.prompt` de `config/elevenlabs-cascade-gpt.trial.json` sobre la base antes de enviar la actualización. El resultado utiliza `gpt-4.1-mini`, sin presupuesto de razonamiento extendido. La variante Flash Lite se conserva para reproducir la comparación, pero no se eligió: inventó un horario de atención en el caso de corrección y fue más lenta.

No exige cuatro preguntas. El modelo recibe el historial, debe conservar negaciones y correcciones, y no debe inventar identidades. El límite de tokens es para respuestas breves, no un sustituto de las reglas de protección. Las respuestas y herramientas del ensayo no acreditan detección de riesgo ni órdenes de corte.

Autenticación del agente habilitada; la app local obtiene un token por el CLI autenticado sin exponer sus credenciales. Una conversación simultánea, 120 segundos por sesión, 18 sesiones diarias del candidato y tres tokens por ejecución local. Estos topes limitan uso, pero no son un límite monetario. No se contrató un plan, número o recarga. Grabación desactivada y eliminación programada de texto y audio; esto no equivale a Zero Retention Mode empresarial.

## Prueba reproducible

Con el CLI de ElevenLabs autenticado, `say` de macOS y FFmpeg:

```bash
node scripts/probar-cascada-voz.mjs --agent agent_ID --out .maritime/cascade-trial/mi-prueba
```

Solo sintetiza las frases ficticias de `eval/cascada-voz-sintetica-v1.json`. Envía PCM16 mono de 16 kHz a ritmo real por WebSocket firmado, espera a que termine el saludo y mide la llegada de la primera trama audible. Una respuesta prematura o ausente no cumple. Los registros de prueba se escriben únicamente bajo `.maritime/`, ignorado por Git y con permisos privados; no contienen claves, URLs firmadas ni audio. No usar este comando como grabador de llamadas reales.

La métrica no incluye búfer ni reproducción del celular y no valida una llamada PSTN de 8 kHz, ruido, voces superpuestas o acento humano. La corrección semántica se revisa por separado. Un porcentaje de riesgo no puede deducirse de estas métricas.

## Conversación WebRTC local

Instalar el SDK en una carpeta privada si no existe:

```bash
npm install --prefix .maritime/cascade-trial/client --no-save --package-lock=false --ignore-scripts @elevenlabs/client
node scripts/cascada-voz-local.mjs --agent agent_ID
```

Abrir la URL que imprime el servidor y pulsar **Iniciar conversación**. Solicita micrófono únicamente al iniciar. No registra texto real en archivos. La transcripción permanece en la página hasta cerrarla. El indicador de latencia del navegador es aproximado porque toma eventos VAD recibidos; los resultados controlados del banco sintético se reportan aparte. El servidor escucha exclusivamente en `127.0.0.1`, valida Host, Origin y un token de la página, y no entrega API keys al navegador.

La vista local no es accesible desde otro celular mediante `localhost`; tampoco cambia la APK instalada. Primero valida reconocimiento y conversación, después debe integrarse el flujo de medios telefónicos y el contrato de eventos de Tiskz. No se reactivó el puente SIP que falló previamente.

Fuentes: [skill oficial de Agents](https://github.com/elevenlabs/skills/blob/main/agents/SKILL.md), [configuración de agente](https://elevenlabs.io/docs/api-reference/agents/update), [SDK JavaScript](https://elevenlabs.io/docs/eleven-agents/libraries/java-script). El esquema y catálogo del CLI autenticado se consultaron antes de elegir las opciones.
