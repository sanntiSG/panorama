# Panorama 360°

Aplicación web que guía al usuario a tomar fotos verticales en puntos calculados de la esfera mientras gira 360° con el celular, y genera una imagen equirectangular (360°×180°) a partir de esas fotos.

- **Cliente**: React + TypeScript + Vite, servido por HTTPS en la red local (para poder probarlo desde un iPhone).
- **Servidor**: Node + Fastify, hace el stitching pesado (features, ajuste geométrico, render, XMP).
- **`shared/`**: la matemática de orientación/cámara/plan de captura, usada literalmente por ambos — el círculo que ves en el móvil y el render final usan el mismo código.

Ver `PLAN.md` (o el plan original de la conversación) para el diseño completo. Este README es solo la guía práctica de "cómo lo enciendo y lo pruebo".

## Instalación

```bash
npm install
```

Instala las dependencias de los tres paquetes (`shared`, `client`, `server`) de una vez (usa npm workspaces).

## Arrancar todo (dos terminales)

```bash
# Terminal 1
npm run dev:server     # Fastify en :3001

# Terminal 2
npm run dev:client     # Vite (HTTPS) en :5173
```

La **primera vez** que arrancas el cliente, `vite-plugin-mkcert` descarga el binario de `mkcert`, crea un CA local y genera un certificado — tarda 1-3 minutos y solo pasa una vez. Verás algo así:

```
➜  Local:   https://localhost:5173/
➜  Network: https://192.168.0.80:5173/
```

Abre la URL de `Network` en tu navegador de escritorio para probar sin el iPhone (activa el "modo simulador" en la pantalla inicial: arrastras con el ratón para rotar, en vez de usar el giroscopio).

## Probar desde el iPhone (misma WiFi)

Safari exige un contexto seguro (HTTPS) para la cámara y el giroscopio, y el certificado que generó mkcert es de una autoridad (CA) que tu PC conoce pero tu iPhone no — hay que decirle al iPhone que confíe en ese CA, una sola vez:

```bash
npm run serve-ca
```

Esto imprime una URL `http://<tu-ip>:3002/` (a propósito por HTTP, no HTTPS — el iPhone todavía no confía en el HTTPS de tu PC). Ábrela en Safari **desde el iPhone**, en la misma WiFi que tu PC, y sigue los pasos que imprime la consola:

1. Toca "Permitir" cuando Safari pregunte si quieres descargar el perfil.
2. **Ajustes → Perfil descargado → Instalar** (pide el código del teléfono).
3. **Ajustes → General → Información → Ajustes de confianza de certificados** → activa la confianza **total** para el certificado recién instalado.
   - Este último paso es el que casi todo el mundo se salta. Sin él, Safari sigue bloqueando `getUserMedia` aunque el perfil ya esté "instalado".

Hecho esto, abre `https://<tu-ip>:5173` desde Safari en el iPhone — debería cargar sin ninguna advertencia de certificado, y "Comenzar" pedirá permiso de cámara y de sensores de movimiento normalmente.

Si cambias de red WiFi, tu IP local cambia — `npm run dev:client` detecta automáticamente las IPs actuales de tu máquina y las mete en el certificado, así que no hay que tocar configuración; solo vuelve a mirar qué URL de `Network` imprime Vite.

**Si algo no cuaja** (firewall corporativo, red de invitados que aísla dispositivos, etc.): `ngrok` está disponible como alternativa — `npx ngrok http 5173` te da una URL HTTPS pública temporal, sin instalar nada en el iPhone, a cambio de que las fotos viajen por internet en vez de por tu WiFi local (más lento).

## Verificación

```bash
npm test              # 56 tests: matemática de orientación/cámara/plan, FFT, align, bundle adjustment, exposición, XMP
npm run synth          # banco de pruebas end-to-end: genera fotos sintéticas con error de giroscopio conocido,
                        # las sube a un servidor real corriendo en :3001 y stitch-ea, reporta el residuo final
```

`npm run synth` necesita el servidor corriendo (`npm run dev:server`). Es la forma de comprobar que un cambio en el pipeline de stitching no rompió nada, sin necesitar el iPhone en la mano — genera una escena sintética con puntos de referencia, simula el error de giroscopio real, y compara.

## Flujo de la app

1. **Setup**: pide permiso de cámara y de orientación/movimiento (en el mismo gesto, como exige iOS), crea una sesión en el servidor.
2. **Captura**: círculos en pantalla indican hacia dónde girar — grises (pendiente), ámbar (acercándote), verdes con anillo de progreso (bloqueado, dispara solo). Cada foto se sube al servidor en cuanto se toma, con una cola local (IndexedDB) que reintenta si se corta la conexión.
3. **Procesado**: el servidor decodifica, empareja fotos solapadas por correlación de fase, ajusta las rotaciones (bundle adjustment), compensa exposición y renderiza la equirectangular — todo con progreso en vivo por SSE.
4. **Resultado**: visor 3D (three.js) para mirar alrededor, y descarga del JPEG final con metadatos de fotoesfera (Google Photos y visores 360° lo reconocen automáticamente).

## Decisiones y simplificaciones respecto al diseño original

Todo lo de abajo es una simplificación **deliberada y documentada** para tener un pipeline completo y funcionando de punta a punta, no una limitación oculta:

- **Sin `@techstark/opencv-js` / ORB**: en vez de detección de features + RANSAC, todo el pipeline usa **correlación de fase** (reproyección a un plano tangente común + FFT) como único método de emparejamiento — la técnica que el plan original reservaba como *fallback* para zonas sin textura pasó a ser el método principal. Es más simple, no depende de una librería WASM pesada, y se valida con verdad de referencia sintética en `server/src/stitch/align.test.ts`.
- **Sin autocalibración de focal**: el bundle adjustment (`server/src/stitch/bundle.ts`) refina solo las **rotaciones** de cada foto, no la distancia focal — mantiene el diseño más simple (medidas de rotación relativa entre pares, sin necesitar correspondencias de píxeles individuales) a costa de no recalibrar el FOV automáticamente sesión tras sesión. La focal de calibración manual/por defecto sigue siendo la que use el cliente.
- **Mezcla por plumeado ponderado**, no multibanda: `render.ts` combina las fotos solapadas con un peso que decae hacia el borde de cada imagen, en vez de una mezcla piramidal por frecuencias. Más simple, buen resultado general, algo peor en detalle de alta frecuencia justo en la costura.
- **Resolución de salida por defecto 4096×2048** (no 8192×4096): motivo de memoria en el equipo de desarrollo — el renderer ya soporta cualquier resolución; se ajusta con la variable de entorno `PANORAMA_OUTPUT_WIDTH` (la altura es siempre la mitad) si tu máquina tiene RAM de sobra, o menos si la tiene justa (ver "Despliegue" más abajo).

## Estructura

```
panorama/
├─ shared/    math de cuaterniones/cámara/orientación + generador del plan de captura (con tests)
├─ client/    app React: cámara, guiado, subida, visor 3D
├─ server/    Fastify: sesiones, subida de fotos, pipeline de stitching (con tests)
├─ tools/     synth.ts — banco de pruebas end-to-end con verdad de referencia sintética
└─ scripts/   serve-ca.mjs — sirve el CA de mkcert por HTTP para instalarlo en el iPhone
```

## Despliegue

En LAN el cliente y el servidor comparten origen (Vite proxea `/api` a `:3001`, ver `client/vite.config.ts`). En producción viven en dos servicios separados — el **servidor** en [Render](https://render.com) y el **cliente** en [Netlify](https://netlify.com) — así que hace falta decirle a cada uno dónde está el otro.

### 1. Servidor en Render

- New → **Blueprint** → selecciona este repo → Render detecta `render.yaml` (plan `free`, healthcheck en `/api/health`) → Deploy.
- Anota la URL que te da (algo como `https://panorama-server.onrender.com`).

`render.yaml` ya fija `PANORAMA_OUTPUT_WIDTH=2048` para caber en el plan gratuito (0.1 CPU / 512MB) — ver limitaciones más abajo.

### 2. Cliente en Netlify

- Add new site → Import from GitHub → selecciona este repo → Netlify detecta `netlify.toml` (build `npm run build -w client`, publish `client/dist`).
- **Antes del primer deploy**, en Site settings → Environment variables, añade `VITE_API_BASE` con la URL de Render del paso 1 (sin barra final), p. ej. `https://panorama-server.onrender.com`. Es una variable de build (Vite la incrusta en el bundle), así que si la cambias después hace falta un redeploy.

### 3. Cerrar el círculo: CORS

Vuelve a Render → Environment → añade `CLIENT_ORIGIN` con la URL de Netlify del paso 2 (p. ej. `https://tu-sitio.netlify.app`) → save (redeploy automático). Sin esto el servidor acepta cualquier origen (`origin: true`, cómodo para probar, pero no lo dejes así en un despliegue real).

### Limitaciones del plan Free de Render (no son bugs)

- **Arranque en frío**: tras 15 min sin tráfico el servicio se duerme; la primera petición tarda ~1 min en responder. Abre la web y espera un momento antes de empezar a capturar.
- **0.1 CPU**: el stitching (`server/src/stitch/pipeline.ts`) es trabajo pesado en JS puro; a 2048×1024 con ~30 fotos puede tardar varios minutos. Si no alcanza, sube de plan y pon `PANORAMA_OUTPUT_WIDTH=4096` (o quítala, es el default).
- **Disco efímero y estado en memoria**: `server/sessions/`, `server/out/` y el registro de sesiones (`sessionStore.ts`, un `Map` en memoria) no sobreviven a un redeploy o reinicio del servicio. Una sesión de captura completa dura minutos, así que no suele ser un problema — pero no esperes que una panorámica a medias siga ahí tras un reinicio.
- **Descarga entre dominios**: el atributo `download` del botón "Descargar" no fuerza la descarga cuando el archivo viene de otro origen (Render, distinto del sitio de Netlify) — el JPEG se abre en una pestaña nueva; en iOS, mantener pulsado → "Añadir a Fotos" funciona igual.
