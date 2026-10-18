# Estado para continuar — 18 de octubre de 2026

Los PR de agents #9 y mobile #12 están fusionados en `main` de sus respectivos repositorios. La APK correspondiente es 0.4.6 (versionCode 10).

## Implementado y publicado

- Servidor `andes-voz`: https://api.maritime.sh/a/ebf0eb81-42c0-4437-a044-1af84af1b755 ; panel: https://maritime.sh/agents.
- Vapi mantiene la voz marin. El backend combina comprensión y detección, y publica transcripciones, estados y órdenes por WebSocket.
- `call.ready_to_answer` corresponde a una revisión actual sin alerta y con estado `observar`. No verifica identidad. Un nuevo turno del llamante invalida la revisión anterior.
- `call.hangup_requested` admite `risk_detected` y `agent_ended`. La APK puede cerrar ambas partes de la conferencia; una despedida del modelo no basta por sí sola.
- Conservación telefónica opcional: hasta 10 s del canal customer, WAV mono PCM16 a 16 kHz, ante alerta principal y con consentimiento separado. La subida usa la API/MCP existente en `org_uav` y no espera para cortar.
- Scribe está en paralelo experimental: compara transcripciones y análisis; sus resultados no controlan el corte principal.

## Verificado y límites de la prueba

Pasaron 87 pruebas Node, 65 JVM, compilación y lint Android. La APK 0.4.6 está instalada en el Samsung de prueba y se activó su opción de conservación. Ese ajuste es local al teléfono; una instalación nueva lo trae apagado.

Se observó en llamadas telefónicas reales la orden `agent_ended` y la desconexión de Android. En dos ensayos, Android registró la desconexión 43 y 45 ms después de recibir la orden, midiendo ambos tiempos con el reloj del teléfono. Esto no mide la latencia completa de la llamada.

En las llamadas revisadas no se confirmó el guardado automático por riesgo: no hubo alerta principal. Una petición aislada de dinero quedó en `verificar`; no debe tratarse como una amenaza confirmada. La transcripción continúa mostrando discrepancias entre motores. La prueba con amenaza explícita y recuperación del WAV sigue sin quedar validada de extremo a extremo. No se ha verificado el resultado final del último intento, interrumpido a petición del usuario para esperar al otro chat.

La API sí pasó una prueba con audio sintético: subida, recuperación idéntica por SHA-256 y eliminación del incidente de prueba. Esto no sustituye la validación del audio humano durante una conferencia.

## Comparación de voces entre llamadas

Es un requisito pendiente, distinto de comparar transcripciones con Scribe. Todavía no hay motor de embeddings conectado ni reconocimiento automático de coincidencias vocales. Guardar WAV no crea una huella de voz. La API admite muestras con modelo/versión y revisión; no generar vectores ficticios ni activar referencias automáticamente. Las coincidencias futuras serán indicios revisables, sin atribuir una identidad.

El chat «Enviar call.ready_to_answer» aportó la señal de revisión ya integrada. Coordinar cualquier trabajo adicional del otro chat antes de cambiar el mismo flujo.

## Continuar con seguridad operativa

1. Hacer `git pull --ff-only origin main` en ambos repositorios. No hay cambios de código locales pendientes al entregar este estado.
2. Revisar [FRAGMENTO_Y_CORTE.md](FRAGMENTO_Y_CORTE.md) y el contrato de eventos antes de cambiar la captura o el corte.
3. Para validar el caso positivo, usar una llamada de prueba autorizada con una amenaza explícita completa y una pausa. Verificar alerta, `audio.capture_result`, archivo recuperable y desconexión de Telecom. Etiquetar el incidente como prueba; no incorporarlo como referencia de fraude real.
4. No reiniciar Maritime durante una llamada. El runtime publicado tiene SHA-256 `947f46211aa308f3c8341347ffd620b32c44dac7c1d6f3558dc20d251ba8580a`. Para futuras subidas usar `scripts/subir-runtime.py`: confirma escritura durable y hash antes del reinicio. Se corrigió un paquete que quedaba vacío al reiniciar sin sincronizar.
5. Credenciales, diagnósticos privados y conversaciones no se suben a Git. Obtener los secretos por el canal privado del equipo.
