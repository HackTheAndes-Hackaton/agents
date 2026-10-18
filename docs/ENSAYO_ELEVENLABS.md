# Ensayo de ElevenLabs para Tiskz

Estado: agente creado y dos conversaciones de audio ficticio verificadas por WebSocket. ID: `agent_6701m56yj6ehfwgbm8arhvvtnm6e`. La cuenta reporta plan gratuito, con extensión de uso deshabilitada. El despliegue de Maritime no cambió.

Se importó un destino SIP entrante (`phnum_2701m56yv9myer4v5w4720cwrqec`) sin comprar ni portar un número. Se configuró un hook `call.ringing` en el número existente de Vapi para transferir silenciosamente al candidato. Se conservó la asignación anterior del asistente y se guardó una copia privada de la configuración anterior. La dirección SIP y la copia se mantienen en `.maritime/eleven-trial/`, fuera de Git. Señalización por TLS y cifrado de medios requerido; IP de origen restringida a las pasarelas documentadas de Vapi y Twilio de Norteamérica. Una ruta guardada no confirma que el proveedor haya conectado una llamada.

Esta ruta es **solo un ensayo de voz telefónica**: no publica transcripciones, porcentajes ni órdenes de corte en la APK. Falta verificar una llamada real, el audio en ambos sentidos y el puente de análisis. No presentarlo como sustitución completa del flujo de Tiskz.

Intentos telefónicos: el usuario informó silencio y no apareció una conversación nueva en ElevenLabs. No se obtuvo un código SIP que permita atribuir la causa exacta. Tras probar una transferencia con `sipVerb: dial`, `mode: blind-transfer` y `dialTimeout: 15`, el usuario volvió a informar que no contestaba. Se retiró la transferencia SIP del número Vapi y se restauró su asignación anterior a marin; la lectura posterior confirmó ambos cambios. El destino importado en ElevenLabs permanece preparado, pero ya no recibe llamadas de este número. No reactivar el hook como si la conectividad estuviera verificada.

## Mediciones iniciales

Dos muestras con voz Paulina de macOS, PCM mono de 16 kHz, enviadas en tiempo real por WebSocket firmado. La referencia es el texto ficticio usado para sintetizar el audio, no una conversación humana real. El primer audio es la llegada de un fragmento con muestras no silenciosas; no incluye la reproducción y el búfer de un teléfono.

| Caso | Primer audio del saludo desde conexión | Fin de audio enviado a transcripción | Fin de audio enviado a primer audio de respuesta |
| --- | ---: | ---: | ---: |
| Reunión sin pagos, códigos ni datos | 1103 ms | 2754 ms | 2823 ms |
| Amenaza con 500 soles por Yape y secreto | 1210 ms | 3842 ms | 4078 ms |

Las dos transcripciones conservaron las negaciones y el significado de las frases; la segunda normalizó «quinientos» a «500». La respuesta cotidiana fue «Entendido. ¿A qué hora sería la reunión?». La segunda fue «Entiendo lo que me dices.»: esto no demuestra detección de riesgo, alerta ni corte. El tiempo de 2,8–4,1 segundos sigue siendo relevante y no acredita una respuesta instantánea. Dos muestras sintéticas no permiten afirmar mejor precisión en español peruano ni una mejora frente a Vapi medida en condiciones equivalentes.

El proveedor confirmó que la primera conversación terminó y no tiene audio guardado. La retención cero es eliminación programada; no implica Zero Retention Mode empresarial.

`config/elevenlabs-agent.trial.json` configura una prueba limitada de conversación: español, saludo inicial, Scribe Realtime, turnos `eager` y voz Sarah con Flash. La API confirmó que Sarah está disponible y las conversaciones usaron esa voz, no marin de OpenAI. El motor de razonamiento es Gemini 2.5 Flash. Elegirlo no demuestra que sea mejor que el actual.

El agente requiere autenticación y limita las sesiones a 120 segundos, una simultánea y diez al día. Esto limita uso, pero no convierte el servicio en gratuito ni impone un tope monetario. No contratar plan, comprar número ni activar recarga. Verificar saldo y condiciones antes de iniciar audio. Grabación desactivada, retención cero con eliminación programada de texto/PII y audio; no equivale a garantizar Zero Retention Mode empresarial.

La configuración se puede validar sin publicarla con el CLI oficial:

```bash
npm exec --yes --package=@elevenlabs/cli -- elevenlabs agents create --dry-run --json - < config/elevenlabs-agent.trial.json
```

## Qué compara esta primera prueba

No conectar herramientas todavía permite medir reconocimiento y conversación sin una espera introducida por herramientas. No se anuncian ni simulan porcentajes o alertas. Probar los mismos casos ficticios del corpus `eval/conversacion-progresiva-v1.json`: solicitud cotidiana, préstamo, amenaza directa, OTP, relato de amenaza recibida, negación y contexto insuficiente. Registrar métricas sin conservar audio ni transcripciones reales en Git.

Medir por separado establecimiento de sesión, primer saludo, fin del habla a primer audio de respuesta y fin del habla a transcripción. Contar omisiones y cambios de negación, importe y petición; comparar solo sobre el mismo audio autorizado y transporte. La prueba WebRTC no valida una conferencia de SIM ni elimina el tiempo de marcar y unir llamadas.

## Integración que falta para los estados y alertas

En un cliente que controla la conversación WebRTC, consumir `user_transcript` y `agent_response` por el SDK, conservar los identificadores de evento y enviar las intervenciones confirmadas al backend de Tiskz. El backend debe publicar el contrato actual de `transcript.update`, `assessment.update`, `alert.updated` y `call.ready_to_answer`, con revisiones y supresión de resultados obsoletos. Las correcciones sustituyen el texto del mismo turno; no se deduplican por texto porque dos turnos iguales pueden ser legítimos. No atribuir identidades a los canales de una conferencia.

El MCP sirve para acciones, pero no debe decidir si llega cada frase al detector. Una solicitud de corte debe pasar por permiso y revisión vigentes y distinguirse de la confirmación real de desconexión. Este candidato no conecta MCP, no emite alertas a la APK y no controla llamadas telefónicas.

Para telefonía hospedada por ElevenLabs, el monitor WebSocket remoto está documentado como Enterprise. Los webhooks posteriores a la llamada llegan demasiado tarde para nuestras alertas. Una alternativa documentada es Custom LLM / Speech Engine, que entrega transcripciones al servidor durante la conversación y permite mantener ahí comprensión/detección. Hay que implementar y verificar esa ruta y el proveedor telefónico; no asumir que el número gratuito administrado por Vapi se puede reutilizar o portar.

Fuentes oficiales consultadas el 18 de octubre de 2026:

- [Skill de Agents](https://github.com/elevenlabs/skills/blob/main/agents/SKILL.md)
- [Eventos del cliente](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events)
- [Monitor en tiempo real: Enterprise](https://elevenlabs.io/docs/eleven-agents/guides/realtime-monitoring)
- [Speech Engine](https://elevenlabs.io/docs/overview/capabilities/speech-engine/)
- [Custom LLM y telefonía](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/custom-llm-integration)
- [Retención](https://elevenlabs.io/docs/eleven-agents/customization/privacy/retention)
