# Estiba · gemelo digital de almacén

Simulación de un turno de almacén (06:00–22:00) en 3D, con indicadores logísticos, análisis de slotting
y un asistente que explica las desviaciones con los datos del propio turno.

**Demo en vivo: https://d1ex3zlctjya5a.cloudfront.net**

No es una maqueta: cada carretilla, camión y palé que se ve sale de un motor de simulación por eventos,
y los indicadores se calculan sobre lo que ocurre en él.

## Qué hace

- **Tres almacenes ficticios** (Zaragoza, Madrid y Barcelona), cada uno con su nave, flota, rutas y un problema distinto:
  - Zaragoza: hoy dos de cinco carretillas pasan por el taller entre las 09:45 y las 15:30.
  - Madrid: el almacén sano, sirve de referencia.
  - Barcelona: la nave va casi llena y el slotting es antiguo.
- **Cadena completa:** camión → patio → muelle → calle de recepción → la carretilla ubica el palé → stock disponible
  → liberación por olas → picking → la ruta sale a su hora. Un fallo en un eslabón se ve en los siguientes.
- **Indicadores:** OTIF, fill rate de líneas, dock-to-stock, utilización y productividad de equipos, ocupación y palés en calles.
  Cada uno se compara con la media de los 14 días anteriores **a la misma hora**.
- **Vistas de la nave:** operativa, nivel de stock por hueco, clasificación ABC y calor de picking.
- **Expediciones:** estado de cada ruta y previsión de riesgo (trabajo pendiente frente a minutos de carretilla disponibles).
- **Optimización:** compara «como está», «ruta optimizada» y «slotting ABC + ruta» sobre los pedidos del día, lista los
  cambios de ubicación de más impacto y permite re-simular el día con el slotting propuesto.
- **Asistente:** responde a preguntas como «¿por qué baja el OTIF?», «¿qué rutas están en riesgo?» o «¿qué hago ahora?»
  recorriendo la cadena de causas. Va en una burbuja flotante; el diagnóstico se calcula en el navegador y Claude
  (Amazon Bedrock) redacta la respuesta a partir de él (`lambda/asistente`).

## Cómo está hecho

| Pieza | Fichero |
| --- | --- |
| Geometría de la nave, distancias reales por pasillos, rutas | `src/sim/layout.js` |
| Motor de simulación (pasos de 15 s, determinista por semilla) | `src/sim/engine.js` |
| Histórico de 14 días y línea base por hora | `src/analysis/history.js` |
| Slotting ABC y secuencia de picking | `src/analysis/optimize.js` |
| Diagnóstico y asistente | `src/analysis/assistant.js` |
| Escena 3D (Three.js, instancias, sombras, etiquetas CSS2D) | `src/scene/warehouse3d.js` |
| Interfaz | `src/main.js`, `src/ui/*` |

Sin frameworks: Vite + Three.js + JavaScript. En producción: S3 + CloudFront (con OAC) para la web y una Lambda
con Function URL para el asistente (`deploy.ps1`).

## Uso

```bash
npm install
npm run dev        # http://localhost:5190
npm test           # pruebas del motor, el slotting y el asistente
npm run build      # genera dist/
node scripts/probar-dia.mjs 5   # indicadores de 5 días por almacén, para calibrar
```

Atajos: espacio pausa, Esc quita la selección.

## Asistente con Bedrock (opcional)

1. Crear una Lambda (Node.js 22) con `lambda/asistente/index.mjs`, permiso `bedrock:InvokeModel` sobre el modelo
   y una Function URL con CORS limitado al dominio de la web. Variable opcional: `TOPE_DIARIO`.
2. Compilar la web con la URL: `VITE_ESTIBA_API=https://…lambda-url…/ npm run build`.

Sin esa variable, el asistente responde solo con el motor local.

## Aviso

Todos los datos son simulados: almacenes, pedidos, proveedores y transportistas son ficticios.

Autor: [Ali Aauicha](https://www.linkedin.com/in/ali-aauicha/)
