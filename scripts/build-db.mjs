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
import {
  COLUMNS,
  FTS_SCHEMA,
  PAGE_SIZE,
  SCHEMA,
  versionFromBuiltAt,
} from './lib/schema.mjs';
import { createReadStream, mkdirSync, statSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
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
    popularity: num(p.popularity_key) ?? 0,
  };
}

const API_FIELDS = [
  'code','product_name','product_name_es','generic_name','brands','quantity',
  'image_front_small_url','image_front_url','ingredients_text','ingredients_text_es',
  'additives_tags','allergens_tags','categories_tags','countries_tags',
  'nutriments','nutriscore_data','nutriscore_grade','nova_group','last_modified_t','popularity_key',
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
        const mapped = mapProduct(p);
        if (!mapped) continue;
        // Un mismo producto puede aparecer en varios paises. Se registra en
        // cada uno, porque en modo --split cada pais tiene su propia base y no
        // son particiones de una sola.
        const key = `${country}:${p.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ row: mapped, country });
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

/** Crea una base vacia con el esquema completo. */
function createDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) unlinkSync(path);
  const db = new Database(path);
  db.exec(SCHEMA);
  db.exec(FTS_SCHEMA);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO products (${COLUMNS.join(',')})
     VALUES (${COLUMNS.map((c) => '@' + c).join(',')})`,
  );
  const insertFts = db.prepare(
    'INSERT INTO products_fts (barcode, name, brands) VALUES (@barcode, @name, @brands)',
  );
  return {
    db,
    path,
    count: 0,
    pending: [],
    // Una transaccion por lote: sin esto habria un fsync por fila.
    flushBatch: db.transaction((rows) => {
      for (const r of rows) {
        insert.run(r);
        insertFts.run({ barcode: r.barcode, name: r.name, brands: r.brands ?? '' });
      }
    }),
  };
}

function finalizeDb(target, maxProducts) {
  /**
   * Recorte por popularidad.
   *
   * Paises como Estados Unidos tienen ~970.000 productos en Open Food Facts,
   * que a 250 B cada uno son 231 MB: por encima del limite de 100 MB por
   * archivo de GitHub. En lugar de partir el archivo (lo que romperia la
   * consulta por rangos, que necesita una sola base), se conservan los mas
   * escaneados.
   *
   * El recorte se hace en SQL y no en memoria a proposito: cargar un millon de
   * objetos en Node para ordenarlos consumiria varios GB en un runner que solo
   * tiene 7.
   */
  if (maxProducts) {
    const before = target.db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
    if (before > maxProducts) {
      target.db.exec(`
        DELETE FROM products WHERE barcode NOT IN (
          SELECT barcode FROM products ORDER BY popularity DESC, barcode ASC LIMIT ${maxProducts}
        );
        DELETE FROM products_fts WHERE barcode NOT IN (SELECT barcode FROM products);
      `);
      const after = target.db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
      console.log(`  ${target.country ?? 'snapshot'}: recortado de ${before.toLocaleString('es')} a ${after.toLocaleString('es')} por popularidad`);
    }
  }

  /**
   * Deduplicar el indice de texto.
   *
   * `products` deduplica sola porque `barcode` es su clave primaria y se
   * inserta con INSERT OR REPLACE. `products_fts` no tiene clave: un producto
   * repetido en el volcado entra dos veces y sale dos veces en las busquedas.
   * Medido sobre el shard de Espana publicado: 339.576 entradas de indice para
   * 339.562 productos, 14 duplicados.
   *
   * Se conserva el rowid mayor, que es la ultima insercion y por tanto la que
   * se corresponde con la fila que quedo en `products`.
   */
  target.db.exec(`
    DELETE FROM products_fts
    WHERE rowid NOT IN (SELECT MAX(rowid) FROM products_fts GROUP BY barcode);
  `);

  const meta = target.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  const builtAt = new Date().toISOString();
  meta.run('built_at', builtAt);
  // Eslabon de la cadena de deltas: el cliente compara SU version con la del
  // indice para saber si le basta con un delta o tiene que bajarlo todo.
  meta.run('version', versionFromBuiltAt(builtAt));
  meta.run('source', 'Open Food Facts (ODbL)');
  meta.run('license', 'ODbL-1.0');
  meta.run('page_size', String(PAGE_SIZE));
  if (target.country) meta.run('country', target.country);
  // VACUUM compacta y deja las paginas contiguas: menos peticiones por consulta.
  target.db.exec('VACUUM');
  target.db.exec('ANALYZE');
  const n = target.db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  target.db.close();
  return {
    path: target.path,
    count: n,
    bytes: statSync(target.path).size,
    country: target.country,
    version: versionFromBuiltAt(builtAt),
  };
}

async function main() {
  /**
   * Con `--split`, en lugar de una base con todos los paises se genera UNA POR
   * PAIS, en la misma pasada sobre el volcado.
   *
   * El motivo es de red, no de gusto: un SQLite comprime un 71%, asi que la
   * base entera de Venezuela son 0,3 MB por la red, menos que dos consultas por
   * rangos. Descargarla completa sale mas barato Y funciona sin conexion, que
   * es justo donde mas falta hace. Solo paises grandes como Espana (70 MB
   * comprimidos) siguen necesitando consulta por rangos.
   */
  const split = Boolean(args.split);
  const outDir = resolve(ROOT, args['out-dir'] ?? dirname(OUT));

  /** @type {Map<string, ReturnType<typeof createDb>>} */
  const targets = new Map();
  const targetFor = (country) => {
    if (!split) {
      if (!targets.has('_all')) targets.set('_all', { ...createDb(OUT), country: null });
      return targets.get('_all');
    }
    if (!targets.has(country)) {
      targets.set(country, {
        ...createDb(resolve(outDir, `${country}.sqlite3`)),
        country,
      });
    }
    return targets.get(country);
  };

  /**
   * Escritura por lotes.
   *
   * Sin transaccion, SQLite hace un fsync por fila: con cientos de miles de
   * productos el proceso pasaria de minutos a horas. Se acumula por destino y
   * se vuelca cada BATCH_SIZE filas dentro de una transaccion.
   */
  const BATCH_SIZE = 5000;

  const flush = (t) => {
    if (t.pending.length === 0) return;
    t.flushBatch(t.pending);
    t.pending = [];
  };

  const write = (row, countries) => {
    // En modo split un producto vendido en varios paises va a cada base: son
    // bases independientes, no particiones de una sola.
    const dests = split ? countries : ['_all'];
    for (const c of dests) {
      const t = targetFor(c);
      t.pending.push(row);
      t.count++;
      if (t.pending.length >= BATCH_SIZE) flush(t);
    }
  };

  const flushAll = () => {
    for (const t of targets.values()) flush(t);
  };

  const wanted = new Set(COUNTRIES);

  if (MODE === 'dump') {
    const useStdin = Boolean(args.stdin);
    const dumpPath = useStdin ? '-' : resolve(ROOT, args.dump ?? 'data/openfoodfacts-products.jsonl.gz');
    if (!useStdin && !existsSync(dumpPath)) {
      console.error(`No se encuentra el volcado en ${dumpPath}`);
      console.error('Descargalo con:');
      console.error('  curl -fL https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz \\');
      console.error('    | node scripts/build-db.mjs --mode=dump --stdin');
      process.exit(1);
    }
    console.log(useStdin ? 'Procesando el volcado desde la entrada estandar ...' : `Procesando ${dumpPath} ...`);
    if (split) console.log(`Una base por pais en ${outDir}`);

    const startedAt = Date.now();
    let seen = 0;
    let kept = 0;

    for await (const p of readDump(dumpPath)) {
      seen++;
      const tags = (p.countries_tags ?? []).map((c) => c.replace(/^en:/, ''));
      const matched = tags.filter((c) => wanted.has(c));
      if (matched.length === 0) continue;
      const mapped = mapProduct(p);
      if (!mapped) continue;
      write(mapped, matched);
      kept++;
      if (seen % 50000 === 0) {
        const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
        process.stdout.write(
          `\r  leidos ${seen.toLocaleString('es')}, guardados ${kept.toLocaleString('es')} (${mins} min)   `,
        );
      }
    }
    flushAll();
    console.log(`\r  leidos ${seen.toLocaleString('es')}, guardados ${kept.toLocaleString('es')}          `);
  } else {
    console.log(`Recolectando desde la API para: ${COUNTRIES.join(', ')}`);
    const collected = await collectFromApi();
    // Cada producto va SOLO a la base del pais del que se obtuvo. Antes se
    // pasaba la lista entera de paises y todos los archivos salian identicos.
    for (const { row, country } of collected) write(row, [country]);
    flushAll();
  }

  // Tope por pais. Sin tope para los pequenos; los grandes se recortan para
  // caber en el limite de 100 MB por archivo de GitHub.
  const caps = {};
  for (const pair of String(args['max-per-country'] ?? 'united-states:300000').split(',')) {
    const [country, n] = pair.split(':');
    if (country && n) caps[country.trim()] = Number(n);
  }
  const results = [...targets.values()].map((t) => finalizeDb(t, caps[t.country ?? '']));

  /**
   * Indice publicado junto a las bases.
   *
   * El cliente lo lee para decidir la estrategia de cada pais SIN tener que
   * adivinar: si el archivo es pequeno lo descarga entero (funciona despues sin
   * conexion), y si es grande lo consulta por rangos. Sin este indice habria
   * que cablear los tamanos en el codigo del cliente y quedarian obsoletos a la
   * primera reconstruccion.
   */
  if (split) {
    const index = {
      generated_at: new Date().toISOString(),
      source: 'Open Food Facts',
      license: 'ODbL-1.0',
      page_size: PAGE_SIZE,
      countries: Object.fromEntries(
        results
          .filter((r) => r.country)
          .map((r) => [
            r.country,
            {
              file: `${r.country}.sqlite3`,
              products: r.count,
              bytes: r.bytes,
              version: r.version,
              deltas: [],
            },
          ]),
      ),
    };
    const indexPath = resolve(outDir, 'index.json');
    writeFileSync(indexPath, JSON.stringify(index, null, 2));
    console.log(`\n  indice: ${indexPath}`);
  }

  console.log('');
  let total = 0;
  for (const r of results.sort((a, b) => b.bytes - a.bytes)) {
    const perProduct = r.count ? (r.bytes / r.count).toFixed(0) : 0;
    console.log(
      `  ${r.path.split('/').pop().padEnd(22)} ${String(r.count).padStart(8)} productos  ` +
        `${(r.bytes / 1024 / 1024).toFixed(2).padStart(8)} MB  ${perProduct} B/producto`,
    );
    total += r.bytes;
    if (r.bytes > 100 * 1024 * 1024) {
      console.log(`     aviso: supera los 100 MB, limite por archivo de GitHub.`);
    }
  }
  console.log(`\n  total: ${(total / 1024 / 1024).toFixed(2)} MB en ${results.length} archivo(s)`);
  if (results.every((r) => r.count === 0)) console.log('\n  Aviso: no se guardo ningun producto.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
