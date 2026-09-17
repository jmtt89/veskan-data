/**
 * Esquema del snapshot, compartido por el constructor y el generador de deltas.
 *
 * Vive aparte porque duplicar `COLUMNS` seria un fallo silencioso y caro: si el
 * constructor anade una columna y el generador de deltas no la conoce, los
 * deltas dejarian de propagar ese dato y los catalogos de los usuarios
 * quedarian con valores viejos SIN que nada fallara ni avisara.
 *
 * Datos de Open Food Facts bajo licencia ODbL. El snapshot derivado hereda ODbL.
 */

/**
 * `page_size` 4096 no es decorativo: debe coincidir con el `blockSize` del
 * RangeReader para que cada lectura de SQLite sea exactamente una peticion
 * Range de un bloque, sin leer de mas.
 */
export const PAGE_SIZE = 4096;

export const SCHEMA = `
PRAGMA page_size = ${PAGE_SIZE};
PRAGMA journal_mode = DELETE;

CREATE TABLE products (
  barcode           TEXT PRIMARY KEY,
  name              TEXT,
  brands            TEXT,
  quantity          TEXT,
  image_url         TEXT,
  ingredients_text  TEXT,
  additives         TEXT,
  allergens         TEXT,
  nova_group        INTEGER,
  nutriscore_grade  TEXT,
  nutriscore_score  INTEGER,
  energy_kj         REAL,
  energy_kcal       REAL,
  fat               REAL,
  saturated_fat     REAL,
  trans_fat         REAL,
  carbohydrates     REAL,
  sugars            REAL,
  fiber             REAL,
  proteins          REAL,
  salt              REAL,
  sodium            REAL,
  fvl               REAL,
  is_beverage       INTEGER,
  is_water          INTEGER,
  is_cheese         INTEGER,
  is_fat_oil_nuts_seeds INTEGER,
  is_red_meat       INTEGER,
  last_modified     INTEGER,
  -- Metrica de escaneos de Open Food Facts. Sirve para dos cosas: acotar los
  -- paises grandes a los productos que la gente escanea de verdad, y ordenar
  -- los resultados de busqueda por relevancia real en vez de alfabeticamente.
  popularity        INTEGER
) WITHOUT ROWID;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

/**
 * El indice FTS va en tabla aparte y NO se crea WITHOUT ROWID: FTS5 necesita
 * rowid. Se enlaza por codigo de barras.
 */
export const FTS_SCHEMA = `
CREATE VIRTUAL TABLE products_fts USING fts5(
  barcode UNINDEXED,
  name,
  brands,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

/**
 * Columnas del snapshot.
 *
 * Se excluyen a proposito `labels_tags`, `countries_tags`, `categories_tags` e
 * `image_front_url`: se comprobo que ni la interfaz ni el motor de puntuacion
 * los leen. Las banderas de categoria que SI necesita Nutri-Score
 * (`is_beverage`, `is_cheese`...) se guardan ya resueltas, asi que la lista de
 * categorias en crudo era puro peso muerto. Se conservan `ingredients_text`
 * (lo usa la inferencia NOVA y la ficha) y `allergens` (se muestran).
 */
export const COLUMNS = [
  'barcode','name','brands','quantity','image_url','ingredients_text','additives','allergens',
  'nova_group','nutriscore_grade','nutriscore_score','energy_kj',
  'energy_kcal','fat','saturated_fat','trans_fat','carbohydrates','sugars','fiber','proteins',
  'salt','sodium','fvl','is_beverage','is_water','is_cheese','is_fat_oil_nuts_seeds','is_red_meat',
  'last_modified','popularity',
];

/** Columnas que alimentan el indice de texto. Solo si cambian se toca el FTS. */
export const FTS_COLUMNS = ['name', 'brands'];

/**
 * Identificador de version de una base.
 *
 * Es la marca de tiempo de construccion en formato compacto UTC
 * (`20260917T031439Z`). Se usa como eslabon de la cadena de deltas, asi que
 * tiene que ser UNICA por construccion: con solo la fecha, dos reconstrucciones
 * el mismo dia darian el mismo identificador y un cliente creeria estar al dia
 * teniendo otra cosa.
 */
export const versionFromBuiltAt = (builtAt) =>
  new Date(builtAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
