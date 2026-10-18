# Recopilación telefónica en producción

La URL del panel se fija en el servidor, no en la APK:

```dotenv
TISKZ_API_URL=https://web-repo-xi.vercel.app/api/v1
TISKZ_AUDIO_API_URL=https://web-repo-xi.vercel.app/api/v1/audio-fragments
```

`npm start` carga `.env` y los secretos adicionales de `.env.local`. El contenedor también incluye la URL de producción por defecto. Las claves privadas y los archivos `.env` reales quedan fuera de Git.

Para recopilar hacen falta el motor instalado con `scripts/instalar-voiceprint.sh`, `TISKZ_API_KEY`, `TISKZ_ORG_ID` y los interruptores del servidor. La instalación verifica el SHA-256 del modelo y mantiene la validación TLS. El hilo del modelo no hereda el bootstrap HTTP de Maritime.

La configuración autorizada de esta instalación activa `VOICEPRINT_ENABLED=true` y `VAPI_PHONE_EVIDENCE_ENABLED=true`; los ejemplos para instalaciones nuevas permanecen apagados. Cada llamada todavía necesita que la APK envíe `consentimiento_conservacion` y `consentimiento_huella_voz`. Sin esos permisos no se conserva su audio ni su huella. No se añade un selector de entorno a la APK.

## Detección, muestra y corte

Una alerta principal puede guardar hasta diez segundos disponibles del canal telefónico, con `speaker: unknown`, y publica `audio.capture_result`. Guardar ese fragmento no bloquea por sí solo la orden de corte.

La recopilación de huellas antes del corte sigue la política existente: alerta con puntuación de al menos 0,90, o alerta y coincidencia vocal fuerte. Esos números son estimaciones sin calibrar, no prueban una estafa ni una identidad. Con permiso y motor disponible, se publica `voice.collecting: started`, se reúne voz hasta veinte segundos activos con un límite de sesenta segundos de espera, se generan hasta tres huellas y se confirma `saved` antes de solicitar el corte. Con evidencia insuficiente se informa el resultado correspondiente. No se reducen a cero los umbrales de riesgo.

En conferencias el canal `customer` puede contener a más de una persona o eco. Las muestras no autentican a quien llama y necesitan revisión. La APK sigue ejecutando el corte al recibir `call.hangup_requested`; no debe cortar solamente por mostrar una alerta si la recopilación autorizada sigue activa.

## Validación del 18 de octubre de 2026

Se ejecutó en la VM un puente telefónico independiente con audio sintético de 8 kHz, motor real y API de producción. Se simularon la transcripción, el detector y las órdenes a Vapi, sin efectuar una llamada telefónica real. Se confirmó:

- Inicio de la recopilación sin corte anticipado.
- Fragmento de audio guardado y confirmación `audio.capture_result: saved`.
- Tres huellas guardadas en un incidente con `simulated: true`.
- Confirmación `voice.collecting: saved` anterior a la solicitud de corte.
- Recuperación de los incidentes desde la API y eliminación de los dos registros de prueba.

El motor produjo 256 valores finitos con una señal sintética de seis segundos en 223 ms durante una comprobación separada. Esa medición no valida reconocimiento de personas ni precisión en conferencias reales. La prueba humana desde la APK sigue siendo necesaria para comprobar recepción de audio y permisos en el teléfono concreto.
