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

## Arrancar todo

Hay dos modos, según qué estés haciendo:

```bash
npm run dev      # iterar: Fastify + Vite (HTTPS), recarga en caliente
npm run local    # capturar de verdad: un solo proceso HTTPS (API + cliente), sin Render
```

### `npm run dev` — para desarrollar

Un solo comando que arranca el servidor y el cliente (antes eran dos terminales:
`npm run dev:server` + `npm run dev:client` — siguen existiendo por separado si los
necesitas, `npm run dev` solo los junta). Si uno de los dos procesos muere, el otro
se detiene también.

La **primera vez** que arrancas el cliente, `vite-plugin-mkcert` descarga el binario de `mkcert`, crea un CA local y genera un certificado — tarda 1-3 minutos y solo pasa una vez. Verás algo así:

```
[client]   ➜  Local:   https://localhost:5173/
[client]   ➜  Network: https://192.168.0.80:5173/
```

Abre la URL de `Network` en tu navegador de escritorio para probar sin el iPhone (activa el "modo simulador" en la pantalla inicial: arrastras con el ratón para rotar, en vez de usar el giroscopio).

### `npm run local` — para capturar una panorámica de verdad

Un único proceso: compila el cliente y arranca el servidor Fastify sirviendo la API
**y** ese build por HTTPS en el mismo origen (`:3001`) — sin CORS, sin depender de que
Render esté despierto, y el stitching corre con el CPU de tu propia máquina en vez del
0.1 CPU del plan gratuito (ver "Limitaciones" más abajo). Reutiliza el mismo CA de
mkcert que ya generó `npm run dev` la primera vez, así que un iPhone que ya confía en
él (ver la sección siguiente) no necesita ningún paso nuevo.

```bash
npm run local
```

Imprime algo así:

```
Abre esto en el iPhone (misma WiFi que este ordenador):
  https://192.168.0.80:3001
```

Necesita haber corrido `npm run dev:client` (o `npm run dev`) al menos una vez antes —
así existe el CA de mkcert que reutiliza. Ctrl+C lo detiene.

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

Hecho esto, abre `https://<tu-ip>:5173` (modo `npm run dev`) o `https://<tu-ip>:3001` (modo `npm run local`) desde Safari en el iPhone — debería cargar sin ninguna advertencia de certificado, y "Comenzar" pedirá permiso de cámara y de sensores de movimiento normalmente.

Si cambias de red WiFi, tu IP local cambia — tanto `npm run dev:client` como `npm run local` detectan automáticamente las IPs actuales de tu máquina y las meten en el certificado, así que no hay que tocar configuración; solo vuelve a mirar qué URL imprimen.

**Si algo no cuaja** (firewall corporativo, red de invitados que aísla dispositivos, etc.): `ngrok` está disponible como alternativa — `npx ngrok http 5173` te da una URL HTTPS pública temporal, sin instalar nada en el iPhone, a cambio de que las fotos viajen por internet en vez de por tu WiFi local (más lento).

## Verificación

```bash
npm test              # 60 tests: matemática de orientación/cámara/plan, FFT, align, bundle adjustment, exposición, XMP
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
└─ scripts/   dev.mjs (un comando para dev), local.mjs (modo local sin Render),
              lan.mjs (IPs de la LAN, usado por ambos), serve-ca.mjs (instala
              el CA de mkcert en el iPhone)
```

## Despliegue

En LAN el cliente y el servidor comparten origen (Vite proxea `/api` a `:3001`, ver `client/vite.config.ts`; `npm run local` también comparte origen, ver más arriba). En producción viven en dos servicios separados — el **servidor** en [Render](https://render.com) y el **cliente** en [Netlify](https://netlify.com) — así que hace falta decirle a cada uno dónde está el otro. Esta sección es la guía paso a paso completa, incluyendo qué credenciales y variables pone cada lado.

**Requisito previo**: el repo tiene que estar en GitHub (ya lo está: `sanntiSG/panorama`) — tanto Render como Netlify se conectan a través de la cuenta de GitHub, no piden usuario/contraseña del proyecto en sí.

### 1. Servidor en Render

1. Entra a **https://dashboard.render.com** e inicia sesión (el botón "GitHub" es lo más simple: autoriza a Render a leer tus repos — puedes limitarlo a solo `panorama` en el diálogo de autorización de GitHub en vez de darle acceso a todos).
2. **New +** (arriba a la derecha) → **Blueprint**.
3. Selecciona el repo `sanntiSG/panorama` de la lista (si no aparece, "Configure account" te lleva a GitHub a concederle acceso a ese repo concreto).
4. Render lee `render.yaml` de la raíz del repo y te muestra el servicio que va a crear: `panorama-server`, plan **Free**, con `PANORAMA_OUTPUT_WIDTH=2048` ya puesto. La variable `CLIENT_ORIGIN` aparece como pendiente de rellenar (tiene `sync: false` en el yaml, a propósito — todavía no existe la URL de Netlify). **Déjala vacía por ahora**, se rellena en el paso 3.
5. **Apply** / **Deploy Blueprint**. Render hace `npm ci` y luego `npm run start -w server` (comandos ya definidos en `render.yaml`, no hay que tocarlos).
6. Espera a que el log de deploy termine y el servicio quede en verde ("Live"). El healthcheck es `/api/health` — si no responde 200 ahí, Render lo marca como fallido y reintenta.
7. **Anota la URL exacta** que Render te asigna, arriba del todo de la página del servicio (algo como `https://panorama-server-xxxx.onrender.com` — el sufijo puede variar; **no asumas** que es la misma URL que tenía el servicio antiguo).
8. Verifica desde tu propia terminal antes de seguir:
   ```bash
   curl -i https://<tu-url-de-render>/api/health
   # esperado: HTTP/1.1 200 OK  y  {"ok":true}
   ```
   Si en cambio ves `x-render-routing: no-server`, el servicio no está corriendo todavía — vuelve al dashboard y revisa el log de deploy.

No hace falta ninguna otra credencial ni variable en este paso — no hay base de datos ni claves de terceros que configurar.

### 2. Cliente en Netlify

1. Entra a **https://app.netlify.com** e inicia sesión (igual que Render, con GitHub es lo más simple).
2. **Add new site → Import an existing project → Deploy with GitHub** → autoriza y selecciona `sanntiSG/panorama`. (Si el sitio `panorammma.netlify.app` que ya existe sigue conectado a este repo, puedes saltar a Site settings de ese sitio en vez de crear uno nuevo — solo hace falta repetir el paso 3.)
3. Netlify lee `netlify.toml` y auto-rellena **Build command**: `npm run build -w client` y **Publish directory**: `client/dist` — confírmalos, no hace falta cambiarlos.
4. **Antes de desplegar** (o antes de disparar el próximo deploy si el sitio ya existe): **Site configuration → Environment variables → Add a variable**:
   - Key: `VITE_API_BASE`
   - Value: la URL de Render del paso 1, **sin barra final** (p. ej. `https://panorama-server-xxxx.onrender.com`)
   - Scopes: todos los contextos de build está bien por defecto.

   Es una variable de **build** (Vite la incrusta en el JS al compilar, no se lee en tiempo de ejecución) — cualquier cambio posterior necesita un redeploy para tener efecto.
5. **Deploy site** (si es nuevo) o **Deploys → Trigger deploy → Clear cache and deploy site** (si ya existía, para asegurarte de que recoge la variable nueva).
6. Anota la URL del sitio (p. ej. `https://panorammma.netlify.app`).

Tampoco hace falta ninguna otra credencial aquí — Netlify solo necesita permiso de lectura del repo de GitHub para clonar y compilar.

### 3. Cerrar el círculo: CORS

1. Vuelve a Render → tu servicio `panorama-server` → **Environment**.
2. Busca (o añade si no aparece) la variable `CLIENT_ORIGIN` → su valor es la URL de Netlify del paso 2, **sin barra final** (p. ej. `https://panorammma.netlify.app`). Si vas a servir desde varios orígenes (p. ej. también un dominio propio), sepáralos por comas: `https://panorammma.netlify.app,https://midominio.com`.
3. **Save Changes** → Render redespliega solo automáticamente.

Sin `CLIENT_ORIGIN`, el servidor acepta cualquier origen (`origin: true` — cómodo para probar, pero no lo dejes así en un despliegue real: cualquier página podría llamar a tu API).

### 4. Verificación final

```bash
# El servidor responde:
curl -i https://<tu-url-de-render>/api/health

# El preflight de CORS ya deja pasar a Netlify (fíjate en la cabecera
# access-control-allow-origin de la respuesta):
curl -i -X OPTIONS https://<tu-url-de-render>/api/sessions \
  -H "Origin: https://<tu-sitio>.netlify.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"
```

Luego abre la URL de Netlify en el iPhone y toca "Comenzar" — no debería aparecer ningún error de CORS ni de conexión en la consola.

### Limitaciones del plan Free de Render (no son bugs)

- **Arranque en frío**: tras un rato sin tráfico el servicio se duerme (y, tras una inactividad mucho más larga, Render puede llegar a darlo de baja del todo — si `curl .../api/health` devuelve `x-render-routing: no-server` en vez de responder, es justo esto: no hay servicio detrás de esa URL, hay que volver a desplegarlo como en el paso 1). La primera petición tras dormir tarda ~1 min en responder — abre la web y espera un momento antes de empezar a capturar.
- **0.1 CPU**: el stitching (`server/src/stitch/pipeline.ts`) es trabajo pesado en JS puro; a 2048×1024 con ~30 fotos puede tardar varios minutos. Si no alcanza, sube de plan y pon `PANORAMA_OUTPUT_WIDTH=4096` (o quítala, es el default) — o, más simple, usa `npm run local` (ver arriba) para capturar con el CPU de tu propia máquina.
- **Disco efímero y estado en memoria**: `server/sessions/`, `server/out/` y el registro de sesiones (`sessionStore.ts`, un `Map` en memoria) no sobreviven a un redeploy o reinicio del servicio. Una sesión de captura completa dura minutos, así que no suele ser un problema — pero no esperes que una panorámica a medias siga ahí tras un reinicio.
- **Descarga entre dominios**: el atributo `download` del botón "Descargar" no fuerza la descarga cuando el archivo viene de otro origen (Render, distinto del sitio de Netlify) — el JPEG se abre en una pestaña nueva; en iOS, mantener pulsado → "Añadir a Fotos" funciona igual.

Si estas limitaciones molestan más de lo que ayuda tener una URL pública, `npm run local` (ver "Arrancar todo" más arriba) evita Render por completo para las sesiones de captura reales, dejando Render/Netlify como vitrina pública opcional.
