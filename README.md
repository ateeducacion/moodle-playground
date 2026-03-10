# Moodle Playground

PoC estática para arrancar Moodle 4.4 dentro del navegador con `php-wasm`, `php-cgi-wasm`, Service Workers y `@electric-sql/pglite`.

Repositorio: `https://github.com/erseco/moodle-playground`

## Estructura

- `index.html`: shell de la PoC, progreso de bootstrap y preview en iframe.
- `app.js`: registro del Service Worker y orquestación del bootstrap.
- `sw.js`: servidor virtual con `PhpCgiWorker`.
- `lib/moodle-loader.js`: descarga del ZIP oficial y escritura en el VFS.
- `lib/config-template.js`: genera `config.php` y `php.ini`.
- `lib/php-runtime.js`: ejemplo explícito de `new PhpWeb({ PGlite })` para pruebas directas.

## Cómo probar

1. Crea tu configuración local:

```bash
cp .env.dist .env
```

2. Ajusta en `.env` lo que necesites, sobre todo `APP_PORT`, `MOODLE_DEFAULT_VERSION`, `MOODLE_AVAILABLE_VERSIONS` o `PHP_WASM_VERSION`.

3. Arranca el servidor local:

```bash
make up
```

4. Abre `http://127.0.0.1:8080/` o el host/puerto que hayas definido.

## Variables de entorno

`make up` genera [lib/runtime-env.js](/Users/ernesto/Dropbox/Trabajo/git/moodle-playground/lib/runtime-env.js) a partir de `.env` o `.env.dist`, de modo que la misma configuración llega al cliente y al Service Worker.
Las dependencias de `php-wasm`, `php-cgi-wasm`, `PGlite` y `fflate` se sirven desde `node_modules` para que el runtime localice correctamente sus assets `.wasm`.
Moodle se descarga, se descomprime durante el build y se empaqueta como `vendor/moodle/<version>/moodle.tar`, con un `manifest.json` por versión. El navegador hace un único fetch del `.tar` por versión en vez de miles de requests de ficheros.

Variables principales:

- `APP_HOST` y `APP_PORT`: origen local desde el que se sirve la PoC.
- `PYTHON_BIN`: binario para `http.server`.
- `PHP_WASM_VERSION`: versión objetivo documentada del runtime local `php-wasm` y `php-cgi-wasm`.
- `MOODLE_ASSET_BASE_URL`: raíz pública de los assets extraídos de Moodle.
- `MOODLE_AVAILABLE_VERSIONS`: versiones que se pueden precargar y copiar a `gh-pages`.
- `MOODLE_DEFAULT_VERSION`: versión activa por defecto en runtime.
- `MOODLE_SOURCE_URL_4_3`, `MOODLE_SOURCE_URL_4_4`: fuentes remotas por versión para `make fetch-moodle`.
- `MOODLE_MANIFEST_URL`: manifiesto que consumirá el navegador. Por defecto apunta a `./vendor/moodle/<default>/manifest.json`.
- `MOODLE_DB_*`: valores usados para generar `config.php`.

## Assets de versiones

- `make fetch-moodle VERSION=4.4`: descarga una versión, la descomprime localmente y genera `moodle.tar`.
- `make fetch-moodles`: descarga y extrae todas las versiones de `MOODLE_AVAILABLE_VERSIONS`.
- `make gh-pages-assets`: prepara `.dist/gh-pages/vendor/moodle/` con `moodle.tar` y `manifest.json` por versión para copiarlo a la rama `gh-pages`.

## Qué hace

1. Registra `sw.js` como Service Worker módulo.
2. Descarga o reutiliza un `moodle.tar` ya preparado según la versión activa.
3. Descomprime Moodle en memoria y lo escribe en el VFS de `php-cgi-wasm`.
4. Genera `config.php` con `dbtype=pgsql` y `dbhost=idb-storage`.
5. Deriva `/moodle/*.php` al worker CGI y sirve assets estáticos desde el mismo VFS.

## Límites actuales

- Esta PoC usa el runtime estándar de `php-wasm`. Moodle puede pedir extensiones adicionales como `intl`, `mbstring`, `xml`, `zip`, `openssl` o `sodium`.
- El estado es efímero. Una recarga completa puede requerir volver a bootstrapear si el worker se reinicia.
- El primer arranque es pesado: Moodle 4.4 ocupa decenas de megabytes comprimido y miles de archivos descomprimidos.
- `make clean` solo elimina residuos locales triviales; no borra `.env`.
