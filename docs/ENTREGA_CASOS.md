# Entrega de casos ficticios a la web

El servicio de voz conserva sus modelos y su protocolo con la app actual. Al cerrar una sesión de prueba puede entregar el contexto humano recibido, tiempos, sesión y detección vigente a `POST /api/v1/case-finalizations`. No genera, guarda ni decide informes. La app no contiene opciones o permisos de reporte y no se modifica.

Configurar exclusivamente en el servidor de voz:

```dotenv
TISKZ_CASE_DELIVERY_ENABLED=true
TISKZ_CASES_SIMULATED=true
TISKZ_API_URL=https://web-repo-xi.vercel.app/api/v1
TISKZ_API_KEY=
TISKZ_ORG_ID=org_vecinal
```

La entrega está desactivada por defecto y solo admite el origen ficticio. La clave es de integración con el panel; xAI se configura en el servidor web, no en voz. Mantener `TISKZ_EVIDENCE_SIMULATED=true` si también se usan clips ficticios. No sustituir las demás variables de voz existentes.

La web determina si está autorizado procesar el caso: para la demo del equipo usa su propia configuración `TISKZ_DEMO_REPORTS_ENABLED=true`. El permiso de análisis o audio del móvil no habilita almacenamiento de reportes. Un permiso explícitamente retirado o una compartición revocada se respeta incluso en la demo.

Se excluye el texto conocido del asistente. El texto de origen se recibe como no verificado; la correlación usa el identificador exacto de sesión y no inventa el número original Android o su IP. En Vapi el inicio corresponde al primer evento recibido por el monitor; el contexto puede ser parcial.

El envío usa TLS, clave de integración y reintentos acotados con el mismo `request_id`. El texto permanece temporalmente en memoria y se libera tras el envío. El corte de la llamada no espera la generación de la web. No hay cola durable: una interrupción abrupta puede perder el envío o dejar un análisis en curso. No publica una VM ni genera una APK.
