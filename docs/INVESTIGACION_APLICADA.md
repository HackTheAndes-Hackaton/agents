# Estudios convertidos en comportamiento verificable

Fecha: 17 de octubre de 2026 (Lima). Alcance: agentes de texto y canal de voz de Tiskz.

Los dos documentos aportados son resúmenes secundarios. Se contrastaron las fuentes primarias de esta tabla; no se importaron sus instrucciones, datos ni cifras como verdades sobre llamadas peruanas.

## Qué se implementó

| Evidencia de investigación | Aplicación en este repositorio | Límite |
| --- | --- | --- |
| [TeleAntiFraud 2.0](https://arxiv.org/html/2609.18748v1): distinguir llamadas legítimas y fraudulentas con aperturas semejantes exige evaluar las acciones posteriores. | `eval/casos-es-PE-v1.json`: ocho parejas con apertura compartida, y evaluación por prefijo sin acceso al futuro. | Son ejemplos originales en español, no una reproducción del benchmark chino ni una muestra representativa de Perú. |
| [Detección incremental con incertidumbre](https://arxiv.org/html/2502.03964v1): abstenerse puede reducir falsas alarmas, con un costo en detección y demora. | `call-policy.mjs`: observar, verificar, alertar o inconcluso; pruebas de error y de resultados de revisiones distintas. | La política orienta. No se ha demostrado que mejore el recall; la orden de corte existente sigue dependiendo del detector y del consentimiento. |
| [Etapas de llamadas de estafa](https://arxiv.org/html/2307.01965v1): autoridad alegada, instrucciones y explotación económica forman parte del desarrollo de una llamada. | Tipos de evidencia: pago, credenciales, acceso remoto, presión, aislamiento y verificación independiente. Se copian segmentos literales por ID y se valida su pertenencia a la transcripción. | La clasificación semántica sigue siendo una inferencia del modelo. Una cita exacta tampoco garantiza una transcripción correcta. |
| [Robustez de detección acústica](https://arxiv.org/abs/2504.12423): códecs y pérdidas de paquetes afectan el rendimiento. | Separación explícita `voz_sintetica.estado: no_evaluada` y protocolo de validación del canal descrito abajo. | No se incorporó un detector acústico ni se extrapolaron resultados de laboratorio a Entel/Vapi. |
| [The Last Mile](https://arxiv.org/html/2608.17585v1): generalización y elección del umbral importan en despliegue. | No se fusiona un supuesto puntaje acústico con el detector; el porcentaje sigue etiquetado como no calibrado. Se conservan resultados y hashes de cada ejecución. | Un Brier bajo en ejemplos de desarrollo no calibra el sistema. |
| [HISPASpoof](https://arxiv.org/html/2509.09155v1): evaluación en español, incluyendo acento peruano y separación de hablantes/generadores. | Candidato documentado para una evaluación acústica posterior, separada de la detección de fraude. | No es el único conjunto con español: el mismo paper describe ODSS. No se descargó ni se entrenó un modelo; antes hay que comprobar licencias de datos y pesos. |

## Comportamiento en ejecución

El detector mantiene su salida booleana y su umbral provisional de 0.5. Una segunda capa, escrita en código, organiza cómo actuar con los dos resultados:

- `alertar`: el detector validado devuelve TRUE. Se conserva la alerta aunque comprensión falle; la explicación puede no estar disponible.
- `inconcluso`: faltan resultados válidos, faltan citas, existe una cita ambigua o aparece un marcador explícito `[inaudible]`, `[ininteligible]` o `[audio no disponible]`, sin una alerta independiente del detector.
- `verificar`: hay peticiones u otras conductas que merecen aclaración, sin alerta del detector. No es una acusación. Una solicitud genérica también puede producir esta orientación conservadora.
- `observar`: las citas disponibles son contextuales y no cumplen lo anterior. No significa llamada segura.

No se inventa una confianza ASR. Ausencia de un marcador de audio faltante no certifica exactitud. En todos los estados las identidades verificadas permanecen vacías y el análisis de voz sintética figura como no evaluado. Una voz humana puede cometer fraude; una voz sintética puede prestar un servicio legítimo.

La orientación viaja como `assessment.update`, con `session_id`, `revision` y `assessment`. Solo se publica cuando ambos agentes han respondido a la revisión actual; los errores también tienen representación explícita. Las citas son datos no confiables para mostrar, nunca instrucciones. La web las trata como texto y muestra la orientación. GPT-Live recibe únicamente el estado y la orientación redactada por el servidor, sin insertar las citas en su contexto de control.

El puente telefónico de Vapi emite el mismo evento. **Esta entrega no modifica el cliente Android para dibujar esos cuatro estados ni inserta la orientación en la conversación de Vapi.** La APK sigue recibiendo sus eventos existentes de comprensión y riesgo; su consumidor de `assessment.update` será una integración adicional. El corte telefónico existente no espera a comprensión y no cambia de umbral. Esta capa no autoriza guardado, SMS ni otras acciones automáticas.

## Evaluación ejecutada

Modelos: `gpt-6-luna` para Decisions y `gpt-4.1-mini` para comprensión. Se ejecutó el código candidato en un directorio temporal de Maritime, con sus créditos, sin llamadas reales. El prompt del detector permaneció igual: la comparación no demuestra una mejora de su precisión respecto de producción.

[Resultado íntegro](../eval/results/2026-10-17-es-PE-v1.json): 20 conversaciones ficticias de dos turnos, 40 evaluaciones. Ocho escenarios positivos, diez negativos y dos sin etiqueta binaria por falta de contexto. Todas las solicitudes de detección respondieron.

- 8/8 escenarios positivos alertaron al aparecer la conducta decisiva, sin alertas anteriores.
- 0/10 conversaciones negativas tuvieron alertas en cualquiera de sus turnos.
- Los dos casos sin etiqueta no generaron alerta; se excluyen de las métricas binarias.
- La exactitud balanceada y F1 macro finales fueron 1.0 **en este pequeño corpus de desarrollo**. No es una estimación de precisión real, un test independiente ni evidencia de que el ASR funcione bien.
- Tiempo medio de las dos inferencias paralelas por turno: 1,007 ms. No mide latencia de audio, red telefónica ni corte de una conferencia.

La ejecución descubrió un fallo de comprensión en `c19`: el texto con `[inaudible]` se clasificó como petición. Se agregó una regla determinista que cambia la orientación a `inconcluso`. La [reejecución de política](../eval/results/2026-10-17-es-PE-v1-policy-replay.json) usa exactamente las mismas decisiones y citas guardadas: cambia ese único estado, sin repetir inferencia ni atribuirse una nueva medición de precisión. Algunas instrucciones de verificación legítima se clasificaron como solicitudes genéricas; por eso `verificar` es una recomendación conservadora, no una alerta.

`eval/evaluate.mjs` mide falsas alertas durante toda la llamada, alertas prematuras, casos omitidos y demora desde el turno decisivo; no solo el resultado final. Reporta fallos y cobertura junto a métricas condicionadas a respuestas válidas, para no esconder un proveedor caído. El Brier es descriptivo sobre etiquetas propuestas, no una calibración. No se ajustó el umbral con estos ejemplos.

## Despliegue verificado

La actualización se publicó en `andes-voz` después de comprobar que no había llamada telefónica ni monitor conectado. [Verificación del servidor desplegado](verificacion-orientacion.json): estado activo, `/health` y `/chat` responden 200. Dos sesiones sintéticas por el WebSocket público confirmaron `verificar` ante «Necesito dinero» e `inconcluso` ante una petición con `[inaudible]`. Se cerraron ambas sesiones. Esto prueba el transporte y análisis de texto; no prueba el audio de Vapi ni una APK física.

## Reproducir

Pruebas deterministas, sin consumir créditos:

```sh
npm test
node scripts/reevaluar-politica.mjs eval/results/2026-10-17-es-PE-v1.json /tmp/tiskz-politica-repetida.json
```

Evaluación nueva, consumiendo créditos del proveedor configurado en `OPENAI_API_KEY` y `OPENAI_BASE_URL` (el endpoint debe ofrecer `/decisions` y `/chat/completions`):

```sh
node scripts/evaluar-fraude.mjs eval/results/nueva-ejecucion.json
```

No sobrescribir snapshots. El runner usa exclusivamente los prefijos de `turns`; etiquetas, escenarios e IDs no se envían al modelo. Registra el hash del corpus y conserva los errores. El resultado original se acompañó también con hashes del código y prompts. Las llamadas son sintéticas y las etiquetas propuestas deben revisarse con personas del dominio antes de considerar este conjunto una prueba de aceptación.

## Validación acústica que falta

No puede resolverse una palabra mal escuchada añadiendo citas de papers al prompt. Para evaluar ASR hacen falta pares autorizados de audio y transcripción manual. Comparar texto manual vs. texto ASR para la misma llamada permite separar error de oído de error del detector. Además de WER/CER, revisar omisiones de negaciones, cifras, pedidos de códigos y turnos; medir falsas alertas y demora con ambos textos. No corregir nombres con suposiciones.

Para evaluar voz sintética, separar entrenamiento, calibración y prueba por hablante y generador; incluir voces humanas y sintéticas tanto en llamadas legítimas como en escenarios fraudulentos. Pasar los mismos audios por los canales realmente usados (WebRTC y una prueba autorizada de Vapi/telefonía), documentando codec, duración, calidad y pérdidas cuando estén disponibles. Un codec simulado no reproduce por sí solo la red de Entel. Medir falsas aceptaciones y falsos rechazos al mismo umbral, cobertura de abstención y latencia; no elegir un umbral distinto para cada ataque del test.

Ningún resultado de síntesis debe verificar identidad o convertir automáticamente un número en «estafador». La captura de evidencia y su conservación mantienen su consentimiento separado. Esta entrega no almacena nuevas llamadas reales, no crea embeddings biométricos y no entrena un clasificador acústico.
