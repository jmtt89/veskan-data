/**
 * Construye el snapshot SQLite estatico (capa L1).
 *
 * Dos modos:
 *   --mode=api   (por defecto) arma un snapshot desde la API de OFF. Rapido, no
 *                exige descargar los 9 GB del volcado completo. Ideal para
 *                desarrollo y para el primer despliegue.
 *   --mode=dump  procesa `openfoodfacts-products.jsonl.gz`. Para el snapshot de
 *                produccion con cientos de miles de productos.
 *
 * El archivo resultante se sirve desde un host que soporte HTTP 206
 * (jsDelivr, raw.githubusercontent, Cloudflare R2) y se consulta por rangos:
 * el navegador descarga solo las paginas que toca cada consulta, no la base.
 *
 * Datos de Open Food Facts bajo licencia ODbL. El snapshot derivado hereda ODbL.
 */

import Database from 'better-sqlite3';
import { createReadStream, mkdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Identificacion ante Open Food Facts. No es autenticacion ni lleva datos
// personales: solo el nombre del proyecto y una URL publica de contacto.
const UA = 'Veskan/0.1 (+https://github.com/jmtt89/veskan)';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const MODE = args.mode ?? 'api';
const OUT = resolve(ROOT, args.out ?? 'data/snapshot.sqlite3');
const COUNTRIES = (args.countries ?? 'spain,mexico,colombia,venezuela,argentina,chile,peru')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PER_COUNTRY = Number(args.limit ?? 300);

/**
 * `page_size` 4096 no es decorativo: debe coincidir con el `blockSize` del
 * RangeReader para que cada lectura de SQLite sea exactamente una peticion
 * Range de un bloque, sin leer de mas.
 */
const PAGE_SIZE = 4096;

const SCHEMA = `
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
  last_modified     INTEGER
) WITHOUT ROWID;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

/**
 * El indice FTS va en tabla aparte y NO se crea WITHOUT ROWID: FTS5 necesita
 * rowid. Se enlaza por codigo de barras.
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE products_fts USING fts5(
  barcode UNINDEXED,
  name,
  brands,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const list = (v) => (Array.isArray(v) && v.length ? v.join(',') : null);
const truthy = (v) => (v === 1 || v === '1' || v === true ? 1 : 0);

function mapProduct(p) {
  const n = p.nutriments ?? {};
  const nd = p.nutriscore_data ?? {};
  const energyKj = num(n['energy-kj_100g']) ?? num(n['energy_100g']);
  const salt = num(n['salt_100g']);
  const sodiumG = num(n['sodium_100g']);
  const name = p.product_name_es || p.product_name || p.generic_name || null;
  if (!p.code || !name) return null; // sin nombre el registro no sirve al usuario

  return {
    barcode: String(p.code),
    name,
    brands: p.brands ?? null,
    quantity: p.quantity ?? null,
    image_url: p.image_front_small_url ?? p.image_front_url ?? null,
    ingredients_text: p.ingredients_text_es || p.ingredients_text || null,
    additives: list(p.additives_tags),
    allergens: list(p.allergens_tags),
    nova_group: num(p.nova_group),
    nutriscore_grade: nd.grade ?? p.nutriscore_grade ?? null,
    nutriscore_score: num(nd.score),
    energy_kj: energyKj,
    energy_kcal: num(n['energy-kcal_100g']) ?? (energyKj !== null ? energyKj / 4.184 : null),
    fat: num(n['fat_100g']),
    saturated_fat: num(n['saturated-fat_100g']),
    trans_fat: num(n['trans-fat_100g']),
    carbohydrates: num(n['carbohydrates_100g']),
    sugars: num(n['sugars_100g']),
    fiber: num(n['fiber_100g']),
    proteins: num(n['proteins_100g']),
    salt: salt ?? (sodiumG !== null ? sodiumG * 2.5 : null),
    sodium: sodiumG !== null ? sodiumG * 1000 : salt !== null ? (salt / 2.5) * 1000 : null,
    fvl:
      num(n['fruits-vegetables-legumes-estimate-from-ingredients_100g']) ??
      num(n['fruits-vegetables-nuts_100g']),
    is_beverage: truthy(nd.is_beverage),
    is_water: truthy(nd.is_water),
    is_cheese: truthy(nd.is_cheese),
    is_fat_oil_nuts_seeds: truthy(nd.is_fat_oil_nuts_seeds),
    is_red_meat: truthy(nd.is_red_meat_product),
    last_modified: p.last_modified_t ? p.last_modified_t * 1000 : null,
  };
}

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
const COLUMNS = [
  'barcode','name','brands','quantity','image_url','ingredients_text','additives','allergens',
  'nova_group','nutriscore_grade','nutriscore_score','energy_kj',
  'energy_kcal','fat','saturated_fat','trans_fat','carbohydrates','sugars','fiber','proteins',
  'salt','sodium','fvl','is_beverage','is_water','is_cheese','is_fat_oil_nuts_seeds','is_red_meat',
  'last_modified',
];

const API_FIELDS = [
  'code','product_name','product_name_es','generic_name','brands','quantity',
  'image_front_small_url','image_front_url','ingredients_text','ingredients_text_es',
  'additives_tags','allergens_tags','categories_tags','countries_tags',
  'nutriments','nutriscore_data','nutriscore_grade','nova_group','last_modified_t',
].join(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Limitador de ritmo por ventana deslizante.
 *
 * Open Food Facts permite 10 busquedas por minuto y por IP. Esperar un intervalo
 * fijo entre peticiones no basta: los REINTENTOS tambien consumen cupo, asi que
 * un fallo arrastra al siguiente y el efecto se acumula hasta que los ultimos
 * paises se quedan sin nada. (Ocurrio: Venezuela, Colombia y Chile terminaron
 * con 0 productos.)
 *
 * Esto cuenta las peticiones REALES de la ultima ventana y espera lo necesario
 * antes de cada una, reintentos incluidos.
 */
class RateLimiter {
  constructor(maxPerWindow = 8, windowMs = 60_000) {
    this.max = maxPerWindow;
    this.windowMs = windowMs;
    this.calls = [];
  }

  async acquire() {
    for (;;) {
      const now = Date.now();
      this.calls = this.calls.filter((t) => now - t < this.windowMs);
      if (this.calls.length < this.max) {
        this.calls.push(now);
        return;
      }
      const wait = this.windowMs - (now - this.calls[0]) + 500;
      process.stdout.write(`\r  (limite de peticiones: esperando ${Math.ceil(wait / 1000)}s)      `);
      await sleep(wait);
    }
  }
}

// 8 de 10 permitidas: se deja holgura deliberada para no rozar el limite.
const limiter = new RateLimiter(8, 60_000);

async function collectFromApi() {
  const out = [];
  const seen = new Set();
  for (const country of COUNTRIES) {
    let collected = 0;
    for (let page = 1; collected < PER_COUNTRY; page++) {
      const url =
        `https://world.openfoodfacts.org/api/v2/search?countries_tags_en=${country}` +
        `&fields=${API_FIELDS}&page_size=100&page=${page}&sort_by=popularity_key`;
      let data;
      for (let attempt = 0; attempt < 6; attempt++) {
        await limiter.acquire();
        try {
          const res = await fetch(url, { headers: { 'User-Agent': UA } });
          if (res.status === 503 || res.status === 429) throw new Error(`HTTP ${res.status}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = await res.json();
          break;
        } catch (e) {
          // Retroceso exponencial: 20s, 40s, 80s... Un 503 significa que el
          // servidor ya esta saturado; insistir enseguida solo lo empeora.
          const backoff = 20000 * 2 ** attempt;
          process.stdout.write(
            `\r  ${country}: reintento ${attempt + 1}/6 tras ${backoff / 1000}s (${e.message})     `,
          );
          await sleep(backoff);
        }
      }
      if (!data) {
        console.log(`\n  AVISO: ${country} no respondio tras 6 intentos. Se continua sin sus datos.`);
        break;
      }
      if (!data?.products?.length) break;
      for (const p of data.products) {
        if (seen.has(p.code)) continue;
        const mapped = mapProduct(p);
        if (!mapped) continue;
        seen.add(p.code);
        out.push(mapped);
        collected++;
      }
      process.stdout.write(`\r  ${country}: ${collected} productos            `);
      if (data.products.length < 100) break;
    }
    process.stdout.write(`\r  ${country}: ${collected} productos            \n`);
  }
  return out;
}

/**
 * Lee el volcado linea a linea, desde un archivo o desde la entrada estandar.
 *
 * La opcion `--stdin` existe por una razon concreta: el volcado JSONL de Open
 * Food Facts pesa **12 GB comprimidos** (no 0,9 GB, que es el del CSV), y un
 * runner de GitHub Actions trae unos 14 GB libres. Guardarlo en disco antes de
 * procesarlo dejaria la maquina al borde y el workflow fallaria de forma
 * intermitente. Transmitiendolo no se almacena nada:
 *
 *   curl -fL <url> | node scripts/build-db.mjs --mode=dump --stdin
 */
async function* readDump(path) {
  const source = path === '-' ? process.stdin : createReadStream(path);
  const rl = createInterface({
    input: source.pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* linea corrupta: se ignora */
    }
  }
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  if (existsSync(OUT)) unlinkSync(OUT);

  const db = new Database(OUT);
  db.exec(SCHEMA);
  db.exec(FTS_SCHEMA);

  const insert = db.prepare(
    `INSERT OR REPLACE INTO products (${COLUMNS.join(',')})
     VALUES (${COLUMNS.map((c) => '@' + c).join(',')})`,
  );
  const insertFts = db.prepare(
    'INSERT INTO products_fts (barcode, name, brands) VALUES (@barcode, @name, @brands)',
  );
  const insertMany = db.transaction((rows) => {
    for (const r of rows) {
      insert.run(r);
      insertFts.run({ barcode: r.barcode, name: r.name, brands: r.brands ?? '' });
    }
  });

  let rows;
  if (MODE === 'dump') {
    const useStdin = Boolean(args.stdin);
    const dumpPath = useStdin ? '-' : resolve(ROOT, args.dump ?? 'data/openfoodfacts-products.jsonl.gz');
    if (!useStdin && !existsSync(dumpPath)) {
      console.error(`No se encuentra el volcado en ${dumpPath}`);
      console.error('Descargalo con:');
      console.error('  curl -L -o data/openfoodfacts-products.jsonl.gz \\');
      console.error('    https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz');
      process.exit(1);
    }
    console.log(useStdin ? 'Procesando el volcado desde la entrada estandar ...' : `Procesando ${dumpPath} ...`);
    const wanted = new Set(COUNTRIES.map((c) => `en:${c}`));
    const startedAt = Date.now();
    let seen = 0;
    let kept = 0;
    let batch = [];
    for await (const p of readDump(dumpPath)) {
      seen++;
      const countries = p.countries_tags ?? [];
      if (wanted.size && !countries.some((c) => wanted.has(c))) continue;
      const mapped = mapProduct(p);
      if (!mapped) continue;
      batch.push(mapped);
      kept++;
      if (batch.length >= 5000) {
        insertMany(batch);
        batch = [];
      }
      if (seen % 50000 === 0) {
        const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
        process.stdout.write(`\r  leidos ${seen.toLocaleString('es')}, guardados ${kept.toLocaleString('es')} (${mins} min)   `);
      }
    }
    if (batch.length) insertMany(batch);
    console.log(`\r  leidos ${seen}, guardados ${kept}          `);
    rows = { length: kept };
  } else {
    console.log(`Recolectando desde la API para: ${COUNTRIES.join(', ')}`);
    const collected = await collectFromApi();
    insertMany(collected);
    rows = collected;
  }

  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'built_at',
    new Date().toISOString(),
  );
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('source', 'Open Food Facts (ODbL)');
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('license', 'ODbL-1.0');
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('page_size', String(PAGE_SIZE));

  // VACUUM compacta y deja las paginas contiguas: menos peticiones Range por
  // consulta, que es justo lo que se quiere optimizar aqui.
  db.exec('VACUUM');
  db.exec('ANALYZE');
  const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  db.close();

  const bytes = statSync(OUT).size;
  console.log(`\nSnapshot: ${OUT}`);
  console.log(`  productos:  ${count}`);
  console.log(`  tamano:     ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  page_size:  ${PAGE_SIZE} B  (${Math.ceil(bytes / PAGE_SIZE)} paginas)`);
  console.log(`  por producto: ${count ? (bytes / count).toFixed(0) : 0} B`);
  if (bytes > 20 * 1024 * 1024) {
    console.log('\n  Aviso: supera los 20 MB, limite por archivo de jsDelivr.');
  }
  if (bytes > 100 * 1024 * 1024) {
    console.log('  Aviso: supera los 100 MB, limite por archivo de GitHub. Parte por region.');
  }
  if (rows.length === 0) console.log('\n  Aviso: no se recolecto ningun producto.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
