# Moodle Playground WASM Status

Fecha de referencia: 2026-03-10

## Objetivo

Levantar Moodle en navegador con `php-wasm`, evitando:

- descargar Moodle oficial en tiempo de ejecución;
- minimizar el tiempo de extracción de ~30k ficheros en MEMFS en cada arranque;
- depender de limpiar manualmente el Service Worker entre pruebas.

## Arquitectura actual

### Frontend

- [`app.js`](/Users/ernesto/Downloads/moodle-playground/app.js)
  - registra y re-registra el Service Worker en cada entrada;
  - arranca el bootstrap;
  - muestra logs de progreso y errores;
  - recibe eventos de debug del Service Worker.

### Service Worker

- [`sw.js`](/Users/ernesto/Downloads/moodle-playground/sw.js)
  - se re-registra con cache-busting;
  - intercepta `/moodle/*`;
  - reenvía las requests al worker PHP por `BroadcastChannel`;
  - devuelve la respuesta al navegador;
  - expone debug de respuestas 4xx/5xx al panel.

### PHP runtime

- [`php-worker.js`](/Users/ernesto/Downloads/moodle-playground/php-worker.js)
  - ejecuta `PhpCgiWorker` en un `Dedicated Worker`, no en el Service Worker;
  - hace bootstrap de Moodle;
  - extrae el bundle ZIP de Moodle en MEMFS;
  - genera `php.ini` y helpers;
  - responde peticiones HTTP enviadas desde `sw.js`;
  - serializa las requests para evitar reentrada simultánea sobre la misma instancia PHP.

### Carga de Moodle

- [`lib/moodle-loader.js`](/Users/ernesto/Downloads/moodle-playground/lib/moodle-loader.js)
  - carga `assets/manifests/latest.json`;
  - prioriza el bundle ZIP si existe;
  - cachea bundle e índice en Cache Storage;
  - ya no hace fallback a descarga remota de Moodle en runtime.

### Extracción del bundle en MEMFS

- [`lib/moodle-loader.js`](/Users/ernesto/Downloads/moodle-playground/lib/moodle-loader.js)
  - `writeEntriesToPhp()` extrae el ZIP directamente en Emscripten MEMFS usando
    operaciones síncronas del FS (`mkdirTree` + `writeFile`) con deduplicación
    de directorios ancestro para rendimiento (~30k archivos en ~2s).
  - todos los ficheros quedan escribibles, lo que permite instalar plugins y
    aplicar parches en runtime sin restricciones.

## Pipeline offline

### Build

- [`scripts/build-moodle-bundle.sh`](/Users/ernesto/Downloads/moodle-playground/scripts/build-moodle-bundle.sh)
  - descarga o reutiliza la release oficial;
  - aplica parches offline al árbol fuente;
  - genera el ZIP de Moodle;
  - genera el manifiesto final.

- [`scripts/generate-manifest.mjs`](/Users/ernesto/Downloads/moodle-playground/scripts/generate-manifest.mjs)
  - genera `assets/manifests/latest.json` con hashes, tamaños y paths.

### Dependencias runtime

- [`scripts/sync-browser-deps.mjs`](/Users/ernesto/Downloads/moodle-playground/scripts/sync-browser-deps.mjs)
  - copia dependencias browser a `vendor/`;
  - parchea rutas de `moduleRoot` para que los `.so` se resuelvan bien;
  - parchea `PhpCgiBase.js` para completar variables CGI y corregir `SCRIPT_NAME`.

### Parches a Moodle

- [`scripts/patch-moodle-source.sh`](/Users/ernesto/Downloads/moodle-playground/scripts/patch-moodle-source.sh)
  - añade `require_once` para `response_aware_exception.php` en `lib/dmllib.php`;
  - añade `require_once` para `lib/classes/session/manager.php` en `install.php`;
  - añade `require_once(__DIR__.'/loader_interface.php')` en `cache/classes/cache.php`.

## Qué se ha resuelto

### Registro y ciclo del Service Worker

- Se eliminó el uso de `import()` dentro del Service Worker.
- El Service Worker se re-registra en cada carga.
- Ya no hace falta limpiar manualmente el SW entre intentos.

### Runtime de PHP

- Se descartó ejecutar PHP dentro del Service Worker.
- PHP ahora vive en `Dedicated Worker`, evitando incompatibilidades directas con `ServiceWorkerGlobalScope`.

### Descarga de Moodle

- Se eliminó la descarga remota desde `download.moodle.org` en runtime.
- Ahora Moodle debe prepararse antes con:
  - `make prepare-dev`
  - `make bundle`
  - o `make bundle-all`

### Bundle y tiempo de arranque

- El core de Moodle se extrae desde un ZIP preconstruido directamente en Emscripten MEMFS.
  `writeEntriesToPhp()` usa operaciones síncronas del FS con deduplicación de directorios
  ancestro, lo que permite escribir ~30k archivos en ~2 segundos.

### Extensiones PHP dinámicas

Se han integrado extensiones runtime mediante `sharedLibs`:

- `iconv`
- `intl`
- `libxml`
- `dom`
- `simplexml`
- `zlib`
- `zip`
- `mbstring`
- `openssl`
- `phar`

### CGI/env

Se corrigieron variables importantes:

- `SERVER_NAME`
- `SERVER_PORT`
- `SERVER_PROTOCOL`
- `SCRIPT_NAME`

Esto arregló varios problemas de generación de URLs y warnings en el instalador.

### Validación del bundle

Se comprueba la integridad del ZIP descargado mediante SHA-256 (`verifyBundle()` en
`lib/moodle-loader.js`). Si el checksum no coincide con el manifest, el bundle cacheado
se descarta y se re-descarga automáticamente.

## Problemas encontrados durante la implementación

### Autoload de Moodle

Han aparecido errores de clases/interfaces no encontradas que no deberían fallar en Moodle normal:

- `core\exception\response_aware_exception`
- `core\session\manager`
- `core_cache\loader_interface`

Se han ido parcheando offline con `require_once` explícitos.

### Bridge SW <-> PHP worker

El bridge ha sufrido:

- timeouts de 15s, luego ampliados a 60s;
- peticiones paralelas al mismo runtime PHP;
- ausencia de visibilidad sobre qué request se estaba procesando.

Ahora:

- el timeout es mayor;
- las requests se serializan;
- se loguea inicio de cada request.

## Estado actual

### Lo que ya está validado

- bootstrap offline;
- bundle local y manifiesto local;
- bundle ZIP generado y extraído en MEMFS;
- `install.php` existe y se lee con el tamaño correcto;
- la request HTTP llega al worker PHP.

### Bloqueo abierto principal

La request:

- `GET /moodle/install.php?lang=en`

entra en el worker PHP, pero no completa. El síntoma actual es:

- `Handling PHP request GET ...`
- no aparece `Completed PHP request ...`
- el Service Worker termina devolviendo `PHP worker bridge timed out`.

Eso significa que el bloqueo ya no está en:

- el fetch del bundle;
- el registro del Service Worker;
- la existencia del fichero `install.php`;
- la carga básica del bundle.

Ahora mismo el problema parece estar dentro de:

- `php.request()` de `php-cgi-wasm`;
- o algún path interno de PHP/Moodle durante la primera ejecución del instalador.

## Últimos cambios relevantes

- se añadió una sanity check tras cargar el bundle para verificar `install.php`;
- se aumentó el timeout del bridge a 60 segundos;
- se serializaron las requests HTTP al runtime PHP;
- se bajó `max_execution_time` a 15s en [`lib/config-template.js`](/Users/ernesto/Downloads/moodle-playground/lib/config-template.js) para intentar obtener un error PHP real antes que un timeout del bridge.

## Comandos útiles

```bash
make prepare-dev
make serve
```

O por partes:

```bash
npm install
npm run sync-browser-deps
./scripts/build-moodle-bundle.sh
npm run serve
```

## Siguiente paso recomendado

El siguiente trabajo útil no es seguir tocando el bundle de Moodle, sino instrumentar el runtime `php-cgi-wasm` para aislar dónde se queda bloqueado `php.request()` con una sola petición activa.

Orden recomendado:

1. instrumentar `vendor/php-cgi-wasm/PhpCgiBase.js` alrededor de `main` y `parseResponse`;
2. comprobar si el cuelgue ocurre antes o después de `php.ccall('main', ...)`;
3. si el bloqueo está en el FS, inspeccionar la extracción del bundle en MEMFS;
4. si el bloqueo es interno del runtime CGI, valorar cambiar de estrategia para servir la primera carga o usar otro modo de integración con `php-wasm`.
