# Rama `aditivos`

Base de datos de peligro de aditivos alimentarios, en Parquet, consultable sin
servidor.

Rama aparte de `data` a propósito: aquélla se reemplaza entera en cada
reconstrucción de catálogos, y esto se borraría con ella. Además las licencias
no son las mismas.

## Qué hay

| tabla | filas | qué es |
|---|---|---|
| `aditivos` | 671 | la sustancia: nombre e identificadores (CAS, PubChem, DSSTox, ECHA, UNII) |
| `aditivo_tags` | 775 | qué números E le corresponden a cada sustancia |
| `gravedad` | 52 | nivel de peligro, certeza, y de dónde sale |
| `prohibiciones` | 32 | prohibiciones y retiradas, una fila por jurisdicción |
| `oft` | 4.387 | EFSA OpenFoodTox: IDA, efecto crítico, especie, dosis |
| `iarc` | 1.040 | clasificación de carcinogenicidad de la IARC |
| `clp` | 1.365 | clasificaciones CMR del Anexo VI del Reglamento CLP |
| `legal_ue` | 344 | estado en el Reglamento (CE) 1333/2008 |
| `legal_eeuu` | 36 | 21 CFR partes 189 y 81 |
| `exposicion` | 260 | riesgo de sobreexposición de EFSA y grupos afectados |
| `familias` · `familia_miembros` | 45 · 130 | grupos de aditivos y sus miembros |
| `motivos_retirada` | 6 | por qué se retiró cada aditivo de la lista de la Unión |
| `gravedad_origen` | 52 | de qué registro exacto sale cada veredicto de gravedad |
| `niveles` | 8 | la escala completa, con cuáles están vacíos |
| `certezas` | 4 | qué significa cada certeza, y en qué eje va |

Y `aditivos.sqlite3`, que es el corte resuelto por número E que consume la
aplicación. Si vas a analizar, usa el Parquet; el SQLite no lleva la evidencia.

## Cómo consultarlo

Lo más simple es bajarlo: el conjunto entero son unos **550 KB**. La cifra
exacta, y la de cada tabla, están en `index.json` — que lo genera el mismo
script que escribe los Parquet, así que no se queda viejo.

```python
import pandas as pd
B = "https://raw.githubusercontent.com/jmtt89/veskan-data/aditivos/"
proh = pd.read_parquet(B + "prohibiciones.parquet")
print(proh[proh.tipo == "prohibicion"][["numero_e", "jurisdiccion", "verbo"]])
```

Con DuckDB se cruzan las tablas directamente:

```sql
SELECT t.numero_e, t.nombre, g.nivel, g.descripcion, p.jurisdiccion
FROM 'aditivo_tags.parquet' t
JOIN 'gravedad.parquet'     g USING (wikidata)
LEFT JOIN 'prohibiciones.parquet' p ON p.tag = t.tag
ORDER BY g.nivel;
```

También se puede leer **por rangos HTTP**, sin descargar el fichero entero: el
pie de un Parquet trae el esquema y los desplazamientos de cada columna.
`raw.githubusercontent.com` responde `206` y manda `access-control-allow-origin: *`,
así que funciona desde un navegador.

Dos avisos si lo haces, los dos comprobados contra GitHub:

**`Range` sólo está en la lista blanca de CORS con inicio explícito.** Un rango
sufijo (`bytes=-8`), que es lo primero que pediría un lector de Parquet para
leer el pie, dispara un *preflight* y GitHub responde `403`. Hay que sacar el
tamaño con `HEAD` y pedir después rangos explícitos.

**No puedes leer `Content-Range` ni `Accept-Ranges` desde otro origen.** GitHub
no manda `Access-Control-Expose-Headers`, así que el navegador te oculta todo
salvo las siete cabeceras seguras de CORS. `Content-Length` sí se lee, porque es
una de ellas. Consecuencia práctica: el lector no puede verificar qué rango le
han devuelto — tiene que llevar él la cuenta de lo que pidió.

No se sirve desde GitHub Pages porque comprime las respuestas y eso rompe las
peticiones por rango.

## Cómo leer los datos

**Prohibición no es lo mismo que retirada**, y la columna `tipo` las separa.
Una prohibición dice que la sustancia no puede usarse; una retirada sólo la
borra de un listado. En seis de las nueve retiradas que hay aquí el motivo no
es la sustancia: es que nadie pagó su reevaluación o que dejó de venderse. La
columna `verbo` guarda la frase literal de la norma para que puedas juzgarlo tú.

**Ausente de una lista positiva tampoco es una prohibición.** La columna
`estado` de `legal_ue` resuelve los cuatro casos sin que haya que combinar
booleanos: `autorizado`, `retirado`, `listado-sin-uso` y `ausente`.

`listado-sin-uso` es el que más engaña: el **E161g**, el E456 y el E463a siguen
en la parte B del reglamento pero no tienen ningún uso alimentario. Ahí
`retirado` es `false` —porque ningún acto los sacó: simplemente no se
trasladaron a la lista de la Unión— y leer sólo ese campo llevaría a la
conclusión contraria.

No confundas ese caso con el **E171**, que es `retirado`: a él **sí** lo sacó un
acto concreto, el Reglamento 2022/63. Que además siga en la parte B porque
colorea medicamentos no lo convierte en `listado-sin-uso`; para eso está la
columna `listado_parte_b`, que puede ser `true` en los dos casos. Son dos hechos
ortogonales y hay una columna para cada uno.

**`nivel` ordena por naturaleza del daño, no por dosis** — 1 es genotóxico o
carcinogénico, 8 es local o digestivo. La escala tiene ocho peldaños y sólo seis
están poblados: la tabla `niveles` trae los ocho con una columna `poblado`, para
que se pueda distinguir «vacío» de «no existe». La potencia va aparte, en `ida`
y `posicion_en_nivel`, **y ahí el 0 es el más potente y el 1 el menos**.

**`certeza` no es una sola escala, son dos.** `confirmada`, `probable` y
`posible` miden cuánto se sabe de una sospecha de cáncer y salen de IARC o del
CLP; ésas sí se ordenan entre sí. `establecida` significa otra cosa: que el
efecto está **medido**, porque es el que fijó la ingesta diaria admisible.
Ponerlas en una única escala es un error de categoría. La tabla `certezas` trae
el eje y el rango de cada una.

**De dónde sale cada veredicto**: `gravedad_origen` da el registro exacto —el
uuid de OpenFoodTox, el nombre de la fila de IARC o el CAS del Anexo VI—. No se
puede reconstruir cruzando CAS: los nitratos y nitritos (E249–E252) los clasificó
IARC por la *condición de exposición*, no por la sal, así que ningún CAS casa.
Esos cuatro llevan `via_enlace = manual`.

**Un número E puede estar reclamado por varias sustancias.** Hay 135 casos, casi
siempre porque una familia y sus miembros comparten identificador. Por eso
existe `aditivo_tags` en vez de una columna.

## Fuentes y licencias

| fuente | licencia |
|---|---|
| Wikidata | CC0 |
| Open Food Facts | ODbL-1.0 |
| EFSA OpenFoodTox | CC-BY-ND |
| Legislación de la Unión Europea | reutilizable sin restricción (Decisión 2011/833/UE) |
| Regulación federal de Estados Unidos | dominio público |
| IARC | uso con atribución |

De OpenFoodTox se extraen **hechos** —una IDA, un NOAEL, una especie, una
dosis—, y los hechos no son objeto de derecho de autor. Cada fila conserva su
identificador de origen para que se pueda volver a la fuente.

Esta base se genera en local con `tools/aditivos/` del repositorio de código, no
en integración continua.
