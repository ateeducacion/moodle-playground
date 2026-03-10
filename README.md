# Moodle Playground

PoC estática para arrancar Moodle 4.4 dentro del navegador con `php-wasm`, `php-cgi-wasm`, Service Workers y `@electric-sql/pglite`.

Plan técnico y análisis comparado con WordPress Playground: `docs/moodle-wasm-plan.md`.

## Estructura

- `index.html`: shell de la PoC, progreso de bootstrap y preview en iframe.
- `app.js`: registro del Service Worker y orquestación del bootstrap.
- `sw.js`: bridge de fetch y caché; el runtime PHP vive en un worker dedicado.
- `php-worker.js`: runtime `php-cgi-wasm` y bootstrap de Moodle.
- `lib/moodle-loader.js`: resolución del manifiesto, caché del bundle e imagen VFS.
- `lib/vfs-mount.js`: mount read-only de la imagen VFS dentro del FS de Emscripten.
- `lib/config-template.js`: genera `config.php` y `php.ini`.
- `lib/php-runtime.js`: ejemplo explícito de `new PhpWeb({ PGlite })` para pruebas directas.

## Cómo probar

Sirve el directorio desde un origen local que soporte Service Workers, por ejemplo:

```bash
python3 -m http.server 8080
```

Abre `http://localhost:8080/`.

Flujo recomendado:

```bash
make prepare
make serve
```

## Cómo generar el bundle

El flujo offline ahora genera:

- un ZIP de Moodle para compatibilidad;
- una imagen VFS `data + index` para el nuevo bootstrap;
- un manifiesto versionado.

```bash
make bundle
```

Salida esperada:

- `assets/moodle/*.zip`
- `assets/moodle/*.vfs.bin`
- `assets/moodle/*.vfs.index.json`
- `assets/manifests/latest.json`

`assets/moodle/`, `assets/manifests/latest.json` y `.cache/` no se versionan. El playground requiere `assets/manifests/latest.json`; no descarga Moodle oficial desde el navegador.

## Qué hace

1. Registra `sw.js` como Service Worker módulo.
2. Intenta cargar `assets/manifests/latest.json` y resolver una imagen VFS preconstruida de Moodle.
3. Reutiliza la imagen desde Cache Storage si ya fue descargada; si no, la baja y la verifica.
4. Monta la imagen VFS directamente sobre `/persist/www/moodle` sin copiar decenas de miles de archivos.
5. Solo escribe los ficheros mutables mínimos, como `config.php`, y deja el resto del core en modo solo lectura.
6. Genera `config.php` con `dbtype=pgsql` y `dbhost=idb-storage`.
7. Deriva `/moodle/*.php` al worker PHP dedicado a través del bridge del Service Worker.

## Límites actuales

- Esta PoC usa el runtime estándar de `php-wasm`. Moodle puede pedir extensiones adicionales como `intl`, `mbstring`, `xml`, `zip`, `openssl` o `sodium`.
- El bloqueo actual confirmado es `iconv`: la release `php-wasm 0.0.9-alpha-32` vendorizada aquí solo trae `libxml2.so`; no incluye `iconv.so`, así que no se puede resolver con `sharedLibs` sin una build custom del runtime.
- El core de Moodle ya no se hidrata archivo a archivo: se monta desde la imagen VFS en memoria.
- La imagen `.vfs.bin` sigue siendo pesada para red y memoria; el cuello restante ya no es la escritura masiva al FS.
- La compatibilidad de escritura sobre el core está limitada de forma intencional; solo se toleran los overrides mínimos del playground.
- Falta persistir `moodledata` y la base materializada para completar las fases 3 y 4 del plan.
- Si no existe `assets/manifests/latest.json`, el bootstrap fallará. Eso es intencional para evitar descargas remotas bloqueadas por CORS.
