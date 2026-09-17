# veskan-data

Snapshot estático de productos alimenticios, consultable desde el navegador por
peticiones HTTP `Range`.

**Este repositorio contiene el script que construye el snapshot, no el snapshot.**
El archivo `.sqlite3` se genera cada noche en GitHub Actions y se publica en
GitHub Pages como artefacto, sin pasar por git. Así el historial del repositorio
no crece, por muchas noches que se regenere.

## Licencia

**ODbL-1.0.** No es una elección: los datos derivan de
[Open Food Facts](https://world.openfoodfacts.org), cuya licencia es
*share-alike*. Cualquier base derivada que distribuyas debe publicarse también
bajo ODbL, con atribución.

Ver [LICENSE](LICENSE).

## Cómo se consume

```
https://raw.githubusercontent.com/jmtt89/veskan-data/data/snapshot.sqlite3
```

El snapshot vive en la rama huérfana `data`, que se reemplaza entera en cada
reconstrucción para que el historial no acumule binarios.

### Por qué raw y no GitHub Pages

Porque **Pages comprime el archivo con gzip y aplica los rangos HTTP al flujo
comprimido**. Verificado el 2026-09-17:

| Petición | `content-length` |
|---|---|
| `HEAD` sin `Accept-Encoding` (curl) | 1.105.920 ← el real |
| `HEAD` con `Accept-Encoding` (navegador) | 317.532 ← comprimido |

Un `Range` devolvía entonces `content-range: …/317532` y bytes que no
corresponden al archivo, así que SQLite respondía `SQLITE_CORRUPT`. Con curl no
se reproducía, porque curl no pide compresión: solo fallaba en navegadores.
jsDelivr se comporta igual. Pages no comprime `image/*`, pero renombrar la base
a `.png` sería una mentira frágil.

`raw.githubusercontent.com` no comprime, respeta los rangos sobre los bytes
reales y responde `access-control-allow-origin: *`. El cliente lee solo las
páginas que necesita en lugar de descargar el archivo entero.

## Estructura del archivo

SQLite con `page_size = 4096`, alineado con el tamaño de bloque que pide el
lector. Dos tablas:

- `products` — `WITHOUT ROWID`, indexada por código de barras
- `products_fts` — índice FTS5 para búsqueda por nombre

Se omiten a propósito las columnas que ningún consumidor lee (categorías en
crudo, etiquetas, países): las banderas que necesita el cálculo del Nutri-Score
se guardan ya resueltas. Eso deja el registro en unos 693 bytes por producto.

## Construirlo a mano

Los scripts de construcción **no viven aquí**, sino en el repositorio de código
[jmtt89/veskan](https://github.com/jmtt89/veskan). Estuvieron duplicados en los
dos repositorios, sincronizados copiando ficheros a mano, y esa es una forma
silenciosa de fallar: si una copia se quedaba atrás, este workflow seguía
publicando catálogos con la versión vieja del algoritmo sin que nada avisara.
Lo que se publica tiene que salir del mismo código que lee la aplicación.

```bash
git clone https://github.com/jmtt89/veskan.git
npm install
node veskan/scripts/build-db.mjs --countries=spain,mexico,colombia,venezuela --limit=500
```

Para el snapshot completo, desde el volcado nocturno de Open Food Facts:

```bash
# El volcado JSONL pesa 12 GB comprimidos. Se transmite en vez de guardarse:
# un runner de GitHub Actions solo tiene ~14 GB libres de disco.
curl -fL https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz \
  | node veskan/scripts/build-db.mjs --mode=dump --stdin \
      --countries=spain,mexico,colombia,venezuela
```

Las rutas se resuelven contra el directorio desde el que se ejecuta, no contra
la ubicación del script, así que las bases salen donde lanzas el comando.

## Límites a vigilar

| Límite | Valor |
|---|---|
| Tamaño del sitio en GitHub Pages | 1 GB |
| Ancho de banda de Pages | 100 GB/mes |
| Bytes por producto | ~693 B |

A 693 B por producto, 100.000 productos son unos 69 MB y 371.511 (todo España)
unos 257 MB. Ambos caben en Pages. Si algún día no cupiera, se parte por región
en varios archivos.
