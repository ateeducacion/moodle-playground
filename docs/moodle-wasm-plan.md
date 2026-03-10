# Moodle WASM Plan

Fecha de análisis: 2026-03-10

## Objetivo

Levantar Moodle completo en navegador con `php-wasm` y publicarlo desde GitHub Pages con el menor tiempo posible hasta tener una instancia utilizable.

El cuello de botella actual no es solo descargar Moodle. El coste real es:

1. Descargar el archivo oficial.
2. Descomprimir decenas de miles de entradas.
3. Escribir miles de ficheros al VFS de `php-wasm`.
4. Repetir parte del trabajo cuando cambia el worker o se invalida el estado.

La estrategia óptima no es “instalar Moodle desde ZIP en cada arranque”, sino “publicar una imagen de Moodle ya preparada para el VFS y cachearla agresivamente”.

## Qué hace WordPress Playground y por qué importa

WordPress Playground separa el problema en artefactos preparados para navegador:

- El runtime WASM.
- Un bundle de datos de WordPress ya listo para montar.
- Un arranque controlado por worker/service worker.
- Persistencia en el navegador para no reinstalar en cada carga.

La idea clave que debemos copiar no es WordPress en sí, sino su forma de evitar trabajo en cliente:

- Preconstruir el sistema de ficheros fuera del navegador.
- Servir pocos artefactos grandes en vez de miles de archivos pequeños.
- Reutilizar caché HTTP, Cache Storage, IndexedDB/IDBFS u OPFS.
- Mantener el bootstrap como “mount + patch mínimo”, no como “download + unzip + copy all”.

## Restricciones específicas de Moodle

Moodle es bastante más duro que WordPress para este enfoque:

- Tiene muchos más ficheros.
- Requiere varias extensiones de PHP.
- Usa `moodledata`, cachés y sesiones de forma intensiva.
- La instalación inicial toca bastante base de datos.
- Su árbol de código cambia menos que `moodledata`, así que conviene separar ambas capas.

Además, la versión oficial actual observada hoy es:

- Rama `stable500`: Moodle `5.0.3`.
- Rama `stable404`: Moodle `4.4.12+`.

## Decisión principal

### No versionar Moodle en Git

No conviene meter el árbol completo de Moodle en este repo:

- Hace el repo pesado e incómodo.
- Duplica un upstream oficial.
- Penaliza clones, diffs y CI.

La alternativa correcta es versionar solo:

- El manifiesto de build.
- Los scripts que preparan los artefactos.
- Checksums y metadatos.
- El código del playground.

Y publicar fuera de Git el payload de Moodle ya procesado.

## Estrategia de empaquetado recomendada

### Opción recomendada: imagen VFS preconstruida por capas

Separar en tres capas publicadas como artefactos estáticos:

1. `runtime/`
   - `php-wasm`, `php-cgi-wasm`, worker scripts y shared libs.
2. `moodle-core/`
   - Snapshot del árbol oficial de Moodle listo para el docroot del VFS.
   - Inmutable por versión de Moodle.
3. `site-seed/`
   - `config.php` mínimo, bootstrap helpers y seed opcional de DB.

Además, persistir aparte:

4. `mutable/`
   - `moodledata`.
   - Base de datos `PGlite`.
   - Cachés de aplicación.

### Formato recomendado

No servir el ZIP oficial al navegador como formato principal de arranque.

Servir en su lugar un bundle preparado para `php-wasm`:

- Opción A: `PRELOAD_ASSETS` de `php-wasm` para generar un `.data` + loader con los ficheros ya indexados.
- Opción B: un tar/zip propio de “pocos archivos grandes” más un índice, si el flujo real de `PRELOAD_ASSETS` no encaja con `php-cgi-wasm`.

La preferencia es A. Si la integración concreta con `PhpCgiWorker` resulta incómoda, pasar a B sin cambiar la arquitectura general.

## Por qué `PRELOAD_ASSETS` es la mejor baza

`php-wasm` permite preinyectar activos en la build o en el arranque. Eso reduce dos costes grandes:

- El número de operaciones JS -> WASM `writeFile`.
- La expansión archivo a archivo en tiempo de arranque.

En la práctica, esto permite que Moodle llegue al navegador como una imagen lista para montar, parecido al `wp.zip`/bundle preparado de WordPress Playground.

## Diseño de arranque propuesto

### Primer uso

1. Cargar app shell desde GitHub Pages.
2. Registrar Service Worker.
3. Comprobar manifiesto local:
   - versión de runtime;
   - versión de Moodle;
   - checksum del bundle;
   - estado de DB y `moodledata`.
4. Si falta `moodle-core`, descargar un único bundle grande y persistirlo.
5. Montar el core en el VFS.
6. Montar `moodledata` persistente.
7. Abrir o crear la base `PGlite`.
8. Inyectar `config.php`.
9. Arrancar Moodle.

### Reentradas normales

1. Restaurar `moodle-core` desde almacenamiento persistente local, no desde red.
2. Reusar `PGlite`.
3. Reusar `moodledata`.
4. Solo invalidar cuando cambie el manifiesto.

Ese es el punto donde debe quedar “rápido”. El coste grande solo puede ocurrir en la primera visita o al cambiar de versión.

## Almacenamiento recomendado

### `moodle-core`: Cache Storage u OPFS/IDBFS

Para GitHub Pages conviene distinguir entre caché HTTP y almacenamiento de trabajo:

- Cache Storage:
  - bueno para conservar el bundle descargado tal cual;
  - simple para versionar por URL y hash.
- OPFS o IDBFS:
  - mejor para materializar el VFS de trabajo.

Recomendación práctica:

- Guardar el bundle original en Cache Storage.
- Desempaquetar o montar una sola vez a OPFS/IDBFS.
- En arranques posteriores, restaurar desde OPFS/IDBFS.

Si `php-wasm` permite montar directamente desde un preload persistido sin rehidratación costosa, mejor aún.

### Base de datos: `pdo-pglite`

Para Moodle, `PGlite` es la opción más razonable en navegador:

- evita depender de un servidor externo;
- encaja con `php-wasm`;
- permite persistencia local;
- es mejor apuesta que “simular MySQL”.

Hay que asumir que algunas rutas de Moodle pueden no comportarse igual que en PostgreSQL nativo, así que la validación debe hacerse sobre instalación, login, navegación básica, creación de curso y subida de recursos.

### `moodledata`

No debe viajar dentro del bundle principal.

Debe inicializarse mínimo y persistirse aparte:

- sesiones;
- cachés;
- temp;
- filedir;
- localcache.

Esto reduce invalidaciones. El core cambia poco; `moodledata` cambia siempre.

## Pipeline de build recomendado

### Build offline en CI, no en cliente

Preparar un job de CI que:

1. Descargue `moodle-latest-500.tgz` o `moodle-latest-404.tgz`.
2. Verifique checksum.
3. Extraiga Moodle.
4. Elimine basura no necesaria para el playground si aplica:
   - docs redundantes;
   - tests no usados en runtime final;
   - fixtures pesadas no necesarias.
5. Genere el bundle VFS.
6. Publique artefactos estáticos versionados por hash.
7. Actualice un `manifest.json`.

Usar `tgz` probablemente será mejor que `zip` en pipeline por ratio y herramientas, aunque en navegador no deberíamos depender ya del paquete oficial.

## Publicación en GitHub Pages

### Qué sí subir

- App shell.
- Service Worker.
- Runtime WASM.
- Shared libs necesarias.
- `manifest.json`.
- Bundle VFS de Moodle.
- Bundle opcional de seed DB.

### Qué no subir al Git del proyecto

- Árbol completo descomprimido de Moodle.
- `moodledata`.
- Artefactos temporales de build.

Los bundles finales sí pueden terminar publicados en la rama/pipeline de Pages o en Releases, pero generados automáticamente, no mantenidos a mano.

## Estructura de artefactos sugerida

```text
/assets/runtime/php-web/
/assets/runtime/php-cgi/
/assets/runtime/libs/
/assets/moodle/5.0.3/core.data
/assets/moodle/5.0.3/core.meta.json
/assets/moodle/5.0.3/db-seed.sql.gz
/assets/manifests/latest.json
```

Si el bundle termina siendo un zip propio en vez de `.data`, la estructura puede ser:

```text
/assets/moodle/5.0.3/core.zip
/assets/moodle/5.0.3/core.index.json
```

## Extensiones PHP a resolver cuanto antes

Antes de optimizar más, hay que fijar una matriz mínima de extensiones soportadas por la build WASM. Moodle suele exigir o usar:

- `mbstring`
- `intl`
- `xml`
- `dom`
- `simplexml`
- `xmlreader`
- `xmlwriter`
- `zip`
- `openssl`
- `sodium`
- `curl`
- `gd`
- `fileinfo`
- `session`
- `ctype`
- `tokenizer`
- `json`
- `pdo`
- `pdo_pgsql` o la vía equivalente que exponga `pdo-pglite`

Si no cerramos esto, cualquier mejora de empaquetado será secundaria.

## Riesgos técnicos reales

### 1. Extensiones de PHP

Es el riesgo principal. Moodle no es viable con la build WASM mínima.

Estado confirmado en este repo a fecha de 2026-03-10:

- El runtime vendorizado `php-wasm/php-cgi-wasm 0.0.9-alpha-32` trae `libxml2.so`.
- No trae `iconv.so`.
- Resultado práctico: Moodle ya alcanza el instalador con el VFS mount, pero se detiene en `Moodle requires the iconv PHP extension`.
- Con esta release concreta no basta con “activar” extensiones mediante configuración; hace falta una build custom del runtime con `iconv` y probablemente más extensiones obligatorias.

### 2. Coste de montar un árbol enorme

Aunque el bundle viaje comprimido, si luego se reescriben decenas de miles de ficheros uno a uno en cada sesión, el tiempo seguirá siendo malo.

### 3. Persistencia del VFS

Hay que confirmar el camino más barato entre:

- preload directo;
- IDBFS;
- OPFS;
- restauración desde bundle cacheado.

### 4. Compatibilidad real de Moodle con `PGlite`

Prometedor, pero hay que probarlo con casos reales de Moodle, no solo con el instalador.

### 5. Límite de tamaño en GitHub Pages + primer download

Un único artefacto muy grande puede seguir ser costoso. Habrá que medir si conviene:

- un solo bundle;
- o varios bundles por zonas calientes/frías.

Mi hipótesis es que para Moodle convendrá 1 bundle principal + 1 seed DB opcional, no miles de shards.

## Plan por fases

### Fase 1: validación dura del runtime

Objetivo: saber si Moodle 4.4/5.0 puede arrancar con una build WASM realista.

Tareas:

- Cambiar el PoC actual para dejar de descargar el ZIP oficial en caliente.
- Probar una build `php-wasm` con extensiones suficientes.
  - mínimo confirmado: `iconv`
  - probablemente también: `mbstring`, `intl`, `xml`, `simplexml`, `xmlreader`, `xmlwriter`, `zip`, `openssl`, `sodium`
- Validar `PGlite` con instalación mínima de Moodle.
- Medir tiempos base.

### Fase 2: bundle VFS offline

Objetivo: sustituir “zip oficial + writeFile masivo” por “core image”.

Tareas:

- Script de build que descargue Moodle oficial.
- Generación de bundle versionado por hash.
- Manifiesto con versión, checksum y metadatos.
- Carga del bundle desde Pages.

### Fase 3: persistencia local

Objetivo: hacer que la segunda carga sea casi inmediata.

Tareas:

- Persistir bundle descargado.
- Persistir DB `PGlite`.
- Persistir `moodledata`.
- Invalidación exacta por hash de manifiesto.

### Fase 4: seed opcional para “demo instantánea”

Objetivo: saltar parte del instalador.

Tareas:

- Crear DB seed inicial.
- Precrear estructura mínima de `moodledata`.
- Entrar directamente a una portada funcional.

Esto es probablemente lo más parecido a la experiencia de WordPress Playground.

## Recomendación concreta para este repo

### Cambios de dirección

El repo actual ya demuestra el flujo correcto de worker + `php-cgi-wasm` + `PGlite`, pero el cargador actual no escala:

- ahora descarga ZIP oficial;
- descomprime en cliente;
- escribe fichero a fichero.

Debe pasar a:

- `manifest.json`;
- `core bundle`;
- caché persistente;
- restore rápido;
- bootstrap mínimo.

### Organización sugerida del repo

```text
/docs/
  moodle-wasm-plan.md
/scripts/
  fetch-moodle-release.sh
  build-moodle-bundle.sh
  generate-manifest.mjs
/public/
  assets/
    manifests/
```

### Política de versionado

Versionar:

- scripts;
- manifiestos fuente;
- código del playground.

No versionar:

- `moodle/` descomprimido;
- bundles generados localmente;
- caches locales.

Publicar artefactos generados mediante GitHub Actions a Pages o Releases.

## Decisión final

La arquitectura óptima para “Moodle en WASM desde GitHub Pages” es:

1. `php-wasm`/`php-cgi-wasm` con extensiones suficientes.
2. `PGlite` como base persistente local.
3. Core de Moodle preempaquetado offline como imagen VFS.
4. `moodledata` fuera del core y persistente.
5. Manifiesto versionado con invalidación por hash.
6. Service Worker para control de caché, bootstrap y recuperación.

No recomiendo seguir con el enfoque de descargar `moodle-latest-*.zip` en cada primer arranque del navegador salvo como fallback de desarrollo.

## Referencias

- WordPress Playground repo: https://github.com/WordPress/wordpress-playground
- WordPress Playground docs: https://wordpress.github.io/wordpress-playground/
- php-wasm docs: https://php-wasm.seanmorr.is/getting-started/home.html
- php-wasm config/build docs: https://php-wasm.seanmorr.is/getting-started/configuration.html
- php-wasm PHP-CGI in Service Workers: https://php-wasm.seanmorr.is/getting-started/php-cgi-in-service-workers.html
- php-wasm changelog (`pdo-pglite`): https://github.com/seanmorris/php-wasm/blob/master/docs/CHANGELOG.md
- Moodle downloads 5.0: https://download.moodle.org/download.php/stable500/moodle-latest-500.tgz
- Moodle downloads 4.4: https://download.moodle.org/download.php/stable404/moodle-latest-404.tgz
- Moodle release/support overview: https://download.moodle.org/releases/
