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
https://jmtt89.github.io/veskan-data/snapshot.sqlite3
```

El servidor de GitHub Pages responde `HTTP 206` con `Content-Range`
(verificado), así que un cliente puede leer solo las páginas que necesite en
lugar de descargar el archivo entero. Una consulta por código de barras
transfiere del orden de 100–200 kB.

## Estructura del archivo

SQLite con `page_size = 4096`, alineado con el tamaño de bloque que pide el
lector. Dos tablas:

- `products` — `WITHOUT ROWID`, indexada por código de barras
- `products_fts` — índice FTS5 para búsqueda por nombre

Se omiten a propósito las columnas que ningún consumidor lee (categorías en
crudo, etiquetas, países): las banderas que necesita el cálculo del Nutri-Score
se guardan ya resueltas. Eso deja el registro en unos 693 bytes por producto.

## Construirlo a mano

```bash
npm install
node scripts/build-db.mjs --countries=spain,mexico,colombia,venezuela --limit=500
```

Para el snapshot completo, desde el volcado nocturno de Open Food Facts:

```bash
# El volcado JSONL pesa 12 GB comprimidos. Se transmite en vez de guardarse:
# un runner de GitHub Actions solo tiene ~14 GB libres de disco.
curl -fL https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz \
  | node scripts/build-db.mjs --mode=dump --stdin \
      --countries=spain,mexico,colombia,venezuela
```

## Límites a vigilar

| Límite | Valor |
|---|---|
| Tamaño del sitio en GitHub Pages | 1 GB |
| Ancho de banda de Pages | 100 GB/mes |
| Bytes por producto | ~693 B |

A 693 B por producto, 100.000 productos son unos 69 MB y 371.511 (todo España)
unos 257 MB. Ambos caben en Pages. Si algún día no cupiera, se parte por región
en varios archivos.
