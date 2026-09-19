# Rama `data`

Una base SQLite por pais, mas `index.json` con sus tamanos.
La rama se reemplaza entera en cada reconstruccion para que el
historial no acumule binarios. El codigo vive en `main`.

Los paises pequenos se descargan enteros y funcionan sin conexion;
los grandes se consultan por rangos HTTP. El cliente lo decide
leyendo `index.json`.

En `deltas/<pais>/<version>.jsonl.gz` van las actualizaciones
incrementales: un cliente con el catalogo de ayer se pone al dia
con kilobytes en vez de volver a bajarse decenas de megas.
Se calculan comparando dos generaciones del snapshot, no con los
deltas de Open Food Facts, que vienen sin datos nutricionales.

Se sirven desde raw.githubusercontent.com porque GitHub Pages
comprime los archivos y eso rompe las peticiones Range.

Datos de Open Food Facts bajo licencia ODbL-1.0.
