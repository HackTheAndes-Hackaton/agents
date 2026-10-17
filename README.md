# Dos agentes contra estafas y extorsiones

Prototipo en español basado en el resumen de HackTheAndes:

1. **andes-comprension** organiza la transcripción autorizada: resumen, solicitudes, hechos, citas e incertidumbres.
2. **andes-deteccion** recibe la transcripción original y el análisis anterior, evalúa señales de riesgo y propone opciones que controla la persona.

Cada agente usa el mismo servidor y un valor distinto de `AGENT_ROLE`. Las citas del modelo se comprueban contra la transcripción. El resultado es provisional y requiere revisión humana.

## Uso

Node.js 24 o posterior; sin dependencias npm.

```sh
export OPENAI_API_KEY=tu-clave
export AGENT_ROLE=comprension
npm start
npm test
```

`GET /health` comprueba el servidor sin invocar al modelo. `POST /chat` recibe `{"message":"<incidente JSON serializado>"}`. El incidente debe incluir `consentimiento_analisis: true` y `transcripcion` no vacía. La respuesta es `{"response":"<análisis JSON serializado>"}`. Un saludo devuelve instrucciones sin llamar al modelo.

Los archivos de `examples/` contienen escenarios ficticios. Tras el despliegue:

```sh
node scripts/analizar.mjs examples/legitimo.json
node scripts/analizar.mjs examples/riesgo.json
maritime status andes-comprension --json
maritime status andes-deteccion --json
```

El flujo duerme Comprensión antes de llamar a Detección porque el plan gratuito permite una máquina despierta a la vez.

## Configuración

- `AGENT_ROLE`: `comprension` o `deteccion`.
- `OPENAI_API_KEY` y `OPENAI_BASE_URL`: acceso al modelo; Maritime puede inyectarlos al habilitar su proxy.
- `OPENAI_MODEL`: por defecto `gpt-4.1-mini`; debe estar disponible en el proveedor.
- `PORT`: puerto inyectado por Maritime; 3000 en desarrollo. Se escucha en `0.0.0.0`.
- `PERSIST_HISTORY`: desactivado por defecto. Con `true`, conserva diez intercambios por `conversationId` bajo `DATA_DIR` (por defecto `/data`). Usa IDs distintos para incidentes independientes.

El agente no guarda transcripciones en disco por defecto. El procesamiento sí envía texto al proveedor del modelo; esta opción no controla la retención de Maritime ni del proveedor. El permiso para analizar es independiente del permiso para conservar o compartir. Las llamadas al modelo consumen créditos de IA separados del alojamiento.

## Despliegue

El Dockerfile está en la raíz. Crea dos agentes de framework `custom` con el mismo código y configura su rol antes de probarlos. El CLI permite subir código local con `maritime agents create --from-dir . --name <nombre> --framework custom --use-maritime-llm --idle-ttl-seconds 600 --json`; esta vía evita requerir acceso del constructor a GitHub privado. El código también puede desplegarse desde GitHub conectando la aplicación de Maritime.

El servicio debe permanecer detrás del acceso autenticado de Maritime: no implementa autenticación propia. Las llamadas al proveedor tienen un límite de 24 segundos para respetar el presupuesto de respuesta de Maritime.

## Alcance

Esta entrega procesa transcripciones. La captura ESP32/INMP441, el transporte autenticado de audio, la transcripción, la aplicación móvil, el panel y la comparación de voz son integraciones posteriores. Los agentes no controlan llamadas, presentan denuncias, publican sospechosos ni identifican personas por su voz.

Los prompts de cada rol están en `prompts/`. Los ejemplos y las pruebas no demuestran precisión general ni probabilidades calibradas.
