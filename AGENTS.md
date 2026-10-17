# Agentes de seguridad de HackTheAndes

Este repositorio implementa dos agentes de análisis de transcripciones autorizadas, con respuestas en español. `AGENT_ROLE=comprension` organiza los hechos; `AGENT_ROLE=deteccion` evalúa señales de riesgo. `AGENT_ROLE=voz` reúne ambos análisis y la señalización WebRTC en una VM. Sus instrucciones están en `prompts/`.

- Mantén separados hechos observados, inferencias y conclusiones revisadas.
- No atribuyas identidades por nombres, números o voz, ni afirmes que una alerta confirma un delito.
- La autorización de análisis no concede permiso para conservar o compartir incidentes.
- No guardes secretos ni transcripciones reales en Git. El historial permanece desactivado por defecto.
- Conserva el contrato de Maritime: `0.0.0.0:$PORT`, `GET /health`, `POST /chat`, respuesta en menos de 30 segundos y persistencia opcional bajo `/data`.
- Usa `npm test` tras modificar el servidor. Los ejemplos deben seguir siendo ficticios.
- Antes de operar Maritime, consulta `.claude/skills/maritime/SKILL.md` y el contrato actual con `maritime guide --json`. No supongas que ambos agentes pueden estar despiertos simultáneamente en el plan gratuito.
