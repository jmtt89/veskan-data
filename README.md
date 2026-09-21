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
| `gravedad` | 53 | nivel de peligro, certeza, y de dónde sale |
| `prohibiciones` | 32 | prohibiciones y retiradas, una fila por jurisdicción |
| `oft` | 5.434 | EFSA OpenFoodTox: IDA, efecto crítico, especie, dosis, los hallazgos de geno/carcinogenicidad y **la conclusión del panel** |
| `oft_historial` | 3.763 | qué dijo cada dictamen anterior de EFSA, con su fecha, su DOI y su panel |
| `iarc` | 1.040 | clasificación de carcinogenicidad de la IARC |
| `clp` | 1.365 | clasificaciones CMR del Anexo VI del Reglamento CLP |
| `legal_ue` | 344 | estado en el Reglamento (CE) 1333/2008 |
| `legal_eeuu` | 36 | 21 CFR partes 189 y 81 |
| `exposicion` | 260 | riesgo de sobreexposición de EFSA y grupos afectados |
| `familias` · `familia_miembros` | 45 · 130 | grupos de aditivos y sus miembros |
| `motivos_retirada` | 6 | por qué se retiró cada aditivo de la lista de la Unión |
| `gravedad_origen` | 53 | de qué registro exacto sale cada veredicto de gravedad |
| `niveles` | 8 | la escala completa, con cuáles están vacíos |
| `certezas` | 4 | qué significa cada certeza, y en qué eje va |

Y `aditivos.sqlite3`, que es el corte resuelto por número E que consume la
aplicación. Si vas a analizar, usa el Parquet; el SQLite no lleva la evidencia.

## Cómo consultarlo

Lo más simple es bajarlo: el conjunto entero son unos **1,23 MB**. La cifra
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

**`hallazgo` no es la conclusión de EFSA**, y es la columna que más fácil se
lee al revés. Resume lo que reportaron los **estudios** de cada expediente, no
lo que dictaminó el panel. El índigo carmín (E132) sale `positivo` y ese mismo
dictamen —[10.2903/j.efsa.2023.8103](https://doi.org/10.2903/j.efsa.2023.8103)—
confirma su IDA de 5 mg/kg y concluye que *«no hay preocupación de seguridad»*.
Por eso `hallazgo` **no alimenta `nivel`**.

**Y la conclusión del panel sí está: es `evaluacion`.** EFSA la escribe con
prefijo codificado dentro de la justificación —`Assessment: some concern;
Remarks: …`— en 6.013 filas del fichero, y el vocabulario es cerrado:
`sin-preocupacion`, `preocupacion-baja`, `alguna-preocupacion`,
`datos-insuficientes`, `faltan-datos`, `datos-de-baja-calidad`.
`evaluacion_texto` trae la frase entera para poder comprobar la etiqueta.

El dióxido de titanio es el caso completo: `hallazgo = positivo` **y**
`evaluacion = alguna-preocupacion`, con el texto diciendo que *«a concern for
genotoxicity could not be ruled out […] E 171 can no longer be considered as
safe when used as a food additive»*. Ése es el dictamen que lo sacó de la
lista de la Unión.

**Cuando no hay `evaluacion`, se lee `hallazgo` junto a `ida`.** Las dos son
hechos y juntas dicen la frase entera:

| | `hallazgo` | `evaluacion` | `ida` | se lee |
|---|---|---|---|---|
| E171 | `positivo` | `alguna-preocupacion` | — | los estudios reportaron algo y el panel concluyó que hay preocupación |
| E132 | `positivo` | — | 5 mg/kg | los estudios reportaron algo y EFSA mantiene una ingesta admisible |

Cuidado con dar la vuelta a esa regla: **la ausencia de IDA no significa por sí
sola que haya preocupación.** El E171 no trae `sin_ida_motivo`; lo que trae es
`sin_dosis_motivo = margen-de-seguridad`, que describe cómo se expresó el valor
de referencia y aparece también en dictámenes que concluyeron que era
aceptable. Para afirmar preocupación, usa `evaluacion`.

**`panel` y `dominio` dicen quién lo evaluó y en qué contexto**, y hacen falta:
EFSA dictamina también sobre **piensos**, y esos dictámenes salen mezclados con
los de alimentos. El de piensos del dióxido de titanio es 41 días más reciente
que el de alimentos, así que ordenar por fecha citaba el equivocado. Se prefiere
el que no es de `EFSA FEEDAP`; los de piensos siguen en `oft_historial`, porque
son parte de la historia del compuesto aunque no sean el dictamen que se cita.

`hallazgo_genotoxico`, `hallazgo_mutagenico` y `hallazgo_carcinogenico` llevan
prefijo para no confundirse con el trío de `clp`, que tiene los mismos nombres
y es otra cosa: clasificación legal del Anexo VI. **No son booleanos**: guardan
el término literal de EFSA —`Positive`, `Negative`, `Ambiguous`, `No data`,
`Not determined`— porque «negativo» y «nadie lo miró» no caben en un booleano
sin perder justo lo que aportan.

154 filas del fichero traen el término con un párrafo pegado detrás
—«Not determined QSAR: no alerts foundConclusion:…»—. El término va siempre
delante, así que se parte: la columna guarda sólo el término y el párrafo va a
`hallazgo_<punto>_nota`. Sin partirlo, agrupar por esa columna daba 154
categorías de una sola fila.

Esa distinción es la que da `estudiado`: `true` si algún dictamen lo midió,
`false` si los hay y ninguno lo midió, y **nulo si no hay ningún expediente**.
Son tres estados distintos y conviene no colapsarlos.

**Un aditivo tiene varios dictámenes y se contradicen.** No es un defecto del
fichero: EFSA vuelve sobre el aditivo cuando hay datos nuevos. El dióxido de
titanio tiene seis, negativos en 2004, 2016, 2018 y 2019 y positivo en 2021
—y fue el de 2021, con datos de nanopartículas, el que llevó a retirarlo de la
lista de la Unión—. La columna `hallazgo` trae el **más reciente que diga
algo**, `dictamenes_discrepan` avisa de que los hay en desacuerdo,
`hallazgos_previos` dice cuáles fueron, y `oft_historial` trae **los demás** con
su fecha y su DOI. Ojo al recuento: `dictamenes_total` los cuenta **todos,
incluido el que se cita**, así que las filas de `oft_historial` son ese número
menos uno. El dióxido de titanio tiene `dictamenes_total = 6` y 5 filas de
historial. Quedarse con uno cualquiera de los seis da la conclusión
contraria la mitad de las veces.

Los DOI se publican desnudos —`10.2903/j.efsa.2023.8103`—, así que la URL es
`https://doi.org/` más el valor. El fichero de EFSA los escribe de tres formas
distintas, dos de ellas rotas; aquí ya vienen normalizados.

**De dónde sale cada veredicto**: `gravedad_origen` da el registro exacto —el
uuid de OpenFoodTox, el nombre de la fila de IARC o el CAS del Anexo VI—. No se
puede reconstruir cruzando CAS: los nitratos y nitritos (E249–E252) los clasificó
IARC por la *condición de exposición*, no por la sal, así que ningún CAS casa.
Esos cuatro llevan `via_enlace = manual`.

**Un número E puede estar reclamado por varias sustancias.** Hay 135 casos, casi
siempre porque una familia y sus miembros comparten identificador. Por eso
existe `aditivo_tags` en vez de una columna.

En 49 de esos 135 unos ítems llevan evidencia y otros no, y en **cuatro** el
que tiene los datos no es el que se encuentra primero. Dos columnas de
`aditivo_tags` lo resuelven sin elegir por ti: `items` dice cuántos ítems
reclaman el tag, y `con_evidencia` cuál de ellos lleva algo.

**`con_evidencia` es ancho a propósito**: cierto si el ítem tiene nivel de
gravedad **o** clasificación de IARC **o** del CLP **o** un valor de
OpenFoodTox. Sirve para desempatar «cuál responde más». Si lo que vas a
afirmar es que existe una *evaluación de peligro*, no uses esta columna:
cruza con `gravedad`, que es literal. Las dos condiciones no dan lo mismo, y
las dos son correctas para lo suyo.

**Y la hermana no siempre es la misma sustancia.** Para eso está
`declara_numero_e`, que dice si Wikidata confirma ese número E para ese ítem
por su propiedad P628:

| tag | ficha vacía | ficha con `gravedad` | `declara_numero_e` | qué es |
|---|---|---|---|---|
| E553b | `Q134583` especie mineral | `Q108584660` compuesto químico | sí | la misma sustancia, dos modelados |
| E523 | `Q419370` sulfato anhidro | `Q27261814` dodecahidrato | sí | la misma sustancia, dos hidratos |
| E407a | `Q288867` *Eucheuma*, un género de algas | `Q421991` carragenano, que declara **E407** | **no** | otra sustancia |
| E924b | `Q416861` bromato de **calcio** | `Q409241` bromato de **potasio** | **no** | otra sustancia |

En los dos últimos es Open Food Facts quien apunta ese número E a la otra
sustancia. Decir «una ficha hermana tiene la evaluación» es cierto arriba y
engañoso abajo, y esa columna es la que lo separa.

`declara_numero_e = false` **no significa enlace erróneo**, y son 198 de 770:
el etanol no declara E1510 en Wikidata y el enlace de Open Food Facts es
correcto. Significa que Wikidata no lo confirma, y eso sólo pesa cuando
`items` es mayor que uno y hay que decidir de cuál se está hablando.

**Cuidado con el grano de las columnas: unas son por tag y otras por ítem.**
`aditivo_tags` tiene una fila por pareja (tag, ítem), y no todas sus columnas
varían igual. `nombre` y `nombre_en` vienen de Open Food Facts y son **del
tag**: si dos ítems comparten tag, los dos traen el mismo nombre. `items`,
`con_evidencia` y `declara_numero_e` sí son **del ítem**.

Eso convierte el consejo fácil en una trampa. Para el 96% de los tags, que
tienen un solo ítem, `aditivo_tags.nombre` es el mejor nombre que hay: cubre
183 sustancias que no tienen etiqueta en español en Wikidata y evita los 4
casos en que Wikidata devuelve el número E como nombre —en el E952 dice
literalmente «E952» donde Open Food Facts dice «Ciclamato»—. Pero en los 135
tags compartidos **te da el mismo nombre para las dos fichas**, que es justo
donde hacía falta distinguirlas.

La regla que funciona:

```sql
CASE WHEN t.items > 1
     THEN coalesce(a.nombre_es, a.nombre_en, t.nombre)   -- del ítem
     ELSE coalesce(t.nombre, a.nombre_es, a.nombre_en)   -- del tag
END
```

El precio es que E523 y E553b salen en inglés, porque ninguna de sus dos
entidades tiene etiqueta española en Wikidata. No hay de dónde sacarla: de los
186 ítems sin `nombre_es`, 185 no tienen ni `aliases.es` ni artículo en la
Wikipedia española, y el único que sí devuelve «E 1451». La salida honesta es
mostrar el inglés y poner el nombre español del tag debajo como alternativo.

**`iarc.anio` va partido en dos.** IARC escribe 72 de las 1.060 filas como
«2025 online» —la monografía publicada en línea antes que el volumen impreso—,
así que la columna no cabía en un entero. En vez de volverla texto, que rompe a
quien ordena por ella, `anio` es `INT32` y `anio_nota` guarda el matiz.

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
