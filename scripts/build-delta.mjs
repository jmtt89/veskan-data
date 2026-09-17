/**
 * Genera los deltas diarios comparando dos generaciones de snapshots.
 *
 * ## Por que no se usan los deltas de Open Food Facts
 *
 * Open Food Facts publica deltas diarios en `data/delta/`, y el plan original
 * era consumirlos. **No sirven**: medido sobre el delta del 2026-09-17 (5.734
 * registros) y sobre el de doce dias antes, el campo `nutriments` viene VACIO
 * en el 100% de los casos -- 1.153 registros lo traen como objeto vacio y
 * ninguno con valores -- mientras que en el volcado completo lo trae relleno el
 * 62%. Aplicarlos borraria energia, azucares, grasas y sal de cada producto
 * actualizado: dejaria el catalogo peor que antes.
 *
 * Asi que el delta se calcula aqui, comparando el snapshot recien construido
 * con el publicado la noche anterior. Sale mas barato de lo que parece porque
 * el volcado completo hay que recorrerlo igualmente cada noche, y ademas:
 *
 *   - lleva TODAS nuestras columnas, no un subconjunto ajeno;
 *   - detecta las bajas reales (un producto que desaparece del volcado), que
 *     los deltas de OFF no marcan y obligaban a una reconstruccion semanal;
 *   - es exacto por construccion: snapshot anterior + delta == snapshot nuevo.
 *
 * ## Uso
 *
 *   node scripts/build-delta.mjs --old=prev --new=out --keep=14
 *
 * Escribe `out/deltas/<pais>/<version>.jsonl.gz` y actualiza `out/index.json`
 * con la cadena de deltas disponible por pais.
 *
 * Datos de Open Food Facts bajo licencia ODbL. Los deltas heredan ODbL.
 */

import Database from 'better-sqlite3';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMNS, FTS_COLUMNS, versionFromBuiltAt } from './lib/schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const OLD_DIR = resolve(ROOT, args.old ?? 'prev');
const NEW_DIR = resolve(ROOT, args.new ?? 'out');
/**
 * Dias de historial. Open Food Facts guarda 13-14; aqui manda otra cosa: un
 * cliente mas viejo que el historial tiene que bajar el catalogo entero, y
 * guardar mas dias solo ayuda a quien no abre la aplicacion en dos semanas.
 */
const KEEP = Number(args.keep ?? 14);
/** Comprueba, aplicandolo, que el delta reproduce exactamente el snapshot nuevo. */
const VERIFY = Boolean(args.verify);

/** `IS NOT` y no `!=`: en SQL, `NULL != NULL` no es cierto, y aqui hace falta que lo sea. */
const difiere = (cols) => cols.map((c) => `n.${c} IS NOT o.${c}`).join(' OR ');

/** Columnas reales de `products` en una base ya construida. */
function columnsOf(path) {
  const db = new Database(path, { readonly: true });
  try {
    return new Set(db.prepare('PRAGMA table_info(products)').all().map((c) => c.name));
  } finally {
    db.close();
  }
}

/** Lee la version de una base ya construida, tolerando las que no la traen. */
function versionOf(path) {
  const db = new Database(path, { readonly: true });
  try {
    const fila = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    if (fila?.value) return fila.value;
    // Las bases publicadas antes de que existiera `version` solo traen
    // `built_at`. Se deriva igual que lo hace el constructor, para que la
    // primera cadena de deltas enganche con ellas en vez de forzar una
    // descarga completa a todo el mundo.
    const built = db.prepare("SELECT value FROM meta WHERE key = 'built_at'").get();
    return built?.value ? versionFromBuiltAt(built.value) : null;
  } finally {
    db.close();
  }
}

/**
 * Calcula el delta de un pais.
 *
 * Las dos consultas son un LEFT JOIN a cada lado, no dos `NOT IN`: sobre
 * 340.000 filas con `barcode` como clave primaria, el join usa el indice y el
 * `NOT IN` habria obligado a materializar la lista entera.
 */
function diff(oldPath, newPath) {
  const db = new Database(newPath, { readonly: true });
  db.exec(`ATTACH DATABASE '${oldPath.replace(/'/g, "''")}' AS viejo`);
  try {
    const comparables = COLUMNS.filter((c) => c !== 'barcode');
    const upserts = db
      .prepare(
        `SELECT ${COLUMNS.map((c) => 'n.' + c).join(',')},
                CASE WHEN o.barcode IS NULL OR ${difiere(FTS_COLUMNS)} THEN 1 ELSE 0 END AS reindexar
         FROM products n
         LEFT JOIN viejo.products o USING (barcode)
         WHERE o.barcode IS NULL OR ${difiere(comparables)}`,
      )
      .all();

    const deletes = db
      .prepare(
        `SELECT o.barcode FROM viejo.products o
         LEFT JOIN products n USING (barcode)
         WHERE n.barcode IS NULL`,
      )
      .all()
      .map((r) => r.barcode);

    return { upserts, deletes };
  } finally {
    db.close();
  }
}

/** Escribe el delta como JSONL comprimido: una cabecera y una linea por cambio. */
async function writeDelta(path, cabecera, upserts, deletes) {
  mkdirSync(dirname(path), { recursive: true });
  async function* lineas() {
    yield JSON.stringify(cabecera) + '\n';
    for (const fila of upserts) {
      const { reindexar, ...row } = fila;
      yield JSON.stringify({ op: 'u', fts: reindexar, ...row }) + '\n';
    }
    for (const barcode of deletes) {
      yield JSON.stringify({ op: 'd', barcode }) + '\n';
    }
  }
  await pipeline(Readable.from(lineas()), createGzip({ level: 9 }), createWriteStream(path));
  return statSync(path).size;
}

/**
 * Comprueba el invariante: catalogo anterior + delta == catalogo nuevo.
 *
 * Es la unica red de seguridad real de esta capa. Un delta mal calculado no
 * falla: deja el catalogo del usuario con datos que ya no corresponden a
 * ninguna version publicada, y la siguiente comparacion lo dara por al dia.
 * Comprobarlo al publicar cuesta segundos; no comprobarlo se paga en los
 * dispositivos de la gente, donde no hay forma de verlo.
 *
 * Se aplica con una implementacion directa y aparte, no reutilizando la del
 * generador: si ambas compartieran el error, la comprobacion no valdria nada.
 */
function verify(oldPath, newPath, upserts, deletes) {
  const copia = `${oldPath}.verificacion`;
  copyFileSync(oldPath, copia);
  const db = new Database(copia);
  try {
    db.exec('BEGIN IMMEDIATE');
    const ins = db.prepare(
      `INSERT OR REPLACE INTO products (${COLUMNS.join(',')}) VALUES (${COLUMNS.map((c) => '@' + c).join(',')})`,
    );
    for (const fila of upserts) {
      const { reindexar, ...row } = fila;
      ins.run(row);
    }
    const del = db.prepare('DELETE FROM products WHERE barcode = ?');
    for (const b of deletes) del.run(b);
    db.exec('COMMIT');

    db.exec(`ATTACH DATABASE '${newPath.replace(/'/g, "''")}' AS esperado`);
    const cols = COLUMNS.join(',');
    const { n } = db.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT ${cols} FROM products EXCEPT SELECT ${cols} FROM esperado.products
         UNION ALL
         SELECT ${cols} FROM esperado.products EXCEPT SELECT ${cols} FROM products
       )`,
    ).get();
    return n;
  } finally {
    db.close();
    if (existsSync(copia)) rmSync(copia);
  }
}

async function main() {
  const indexPath = resolve(NEW_DIR, 'index.json');
  if (!existsSync(indexPath)) {
    console.error(`No se encuentra ${indexPath}. Ejecuta antes build-db.mjs --split.`);
    process.exit(1);
  }
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));

  if (!existsSync(OLD_DIR)) {
    console.log(`No hay generacion anterior en ${OLD_DIR}: primera publicacion, sin deltas.`);
    return;
  }

  // El historial anterior se arrastra: la rama `data` se reemplaza entera en
  // cada reconstruccion, asi que lo que no se copie aqui desaparece.
  const oldDeltas = resolve(OLD_DIR, 'deltas');
  const newDeltas = resolve(NEW_DIR, 'deltas');
  let heredadas = 0;
  if (existsSync(oldDeltas)) {
    mkdirSync(newDeltas, { recursive: true });
    for (const pais of readdirSync(oldDeltas)) {
      const src = resolve(oldDeltas, pais);
      if (!statSync(src).isDirectory()) continue;
      mkdirSync(resolve(newDeltas, pais), { recursive: true });
      for (const f of readdirSync(src)) {
        writeFileSync(resolve(newDeltas, pais, f), readFileSync(resolve(src, f)));
        heredadas++;
      }
    }
  }
  if (heredadas) console.log(`  ${heredadas} delta(s) anteriores conservados`);

  const previo = existsSync(resolve(OLD_DIR, 'index.json'))
    ? JSON.parse(readFileSync(resolve(OLD_DIR, 'index.json'), 'utf8'))
    : { countries: {} };

  for (const [pais, entry] of Object.entries(index.countries)) {
    const partesNuevas = entry.parts ?? [{ file: `${pais}.sqlite3`, from: null, to: null }];
    const partesViejas = previo.countries?.[pais]?.parts ?? [
      { file: `${pais}.sqlite3`, from: null, to: null },
    ];

    /**
     * Si el catalogo se ha vuelto a partir, NO hay delta.
     *
     * Al cambiar los cortes las filas se mudan de archivo, y un delta de filas
     * no sabe expresar una mudanza: el cliente aplicaria altas en una parte sin
     * darse de baja en la otra y acabaria con el producto duplicado. Cuando
     * pasa, toca descargar el catalogo entero, igual que con un cambio de
     * esquema. Por eso los cortes se congelan y esto deberia ser raro.
     */
    const mismosCortes =
      partesViejas.length === partesNuevas.length &&
      partesNuevas.every((p, i) => (p.from ?? '') === (partesViejas[i].from ?? '') &&
                                    (p.to ?? '') === (partesViejas[i].to ?? ''));
    if (!mismosCortes) {
      console.log(
        `  ${pais}: el catalogo se ha partido de otra forma ` +
          `(${partesViejas.length} → ${partesNuevas.length} partes), sin delta`,
      );
      for (const p of partesNuevas) p.deltas = [];
      continue;
    }

    for (const [i, parte] of partesNuevas.entries()) {
      const etiqueta = partesNuevas.length === 1 ? pais : `${pais} parte ${i + 1}`;
      const oldPath = resolve(OLD_DIR, partesViejas[i].file);
      const newPath = resolve(NEW_DIR, parte.file);

      if (!existsSync(oldPath)) {
        console.log(`  ${etiqueta}: sin version anterior, solo el catalogo completo`);
        parte.deltas = [];
        continue;
      }

      const faltan = COLUMNS.filter((c) => !columnsOf(oldPath).has(c));
      if (faltan.length) {
        console.log(
          `  ${etiqueta}: el esquema cambio (faltan: ${faltan.join(', ')}), sin delta; ` +
            'los clientes bajaran el catalogo completo',
        );
        parte.deltas = [];
        continue;
      }

      const from = versionOf(oldPath);
      const to = entry.version;
      if (!from || !to) {
        console.log(`  ${etiqueta}: falta la version en una de las dos bases, sin delta`);
        parte.deltas = [];
        continue;
      }
      if (from === to) {
        console.log(`  ${etiqueta}: misma version (${from}), sin delta`);
        parte.deltas = partesViejas[i].deltas ?? [];
        continue;
      }

      const t0 = Date.now();
      const { upserts, deletes } = diff(oldPath, newPath);
      // La ruta lleva el numero de parte: cada una tiene su propia cadena.
      const carpeta = partesNuevas.length === 1 ? pais : `${pais}/${String(i + 1).padStart(2, '0')}`;
      const rel = `deltas/${carpeta}/${to}.jsonl.gz`;
      const bytes = await writeDelta(
        resolve(NEW_DIR, rel),
        {
          format: 1,
          country: pais,
          part: i + 1,
          from,
          to,
          upserts: upserts.length,
          deletes: deletes.length,
          columns: COLUMNS,
        },
        upserts,
        deletes,
      );

      if (VERIFY) {
        const difs = verify(oldPath, newPath, upserts, deletes);
        if (difs !== 0) {
          console.error(
            `::error::El delta de ${etiqueta} NO reproduce el snapshot: ${difs} filas distintas. No se publica.`,
          );
          process.exit(1);
        }
      }

      const cadena = [...(partesViejas[i].deltas ?? [])];
      cadena.push({ from, to, file: rel, bytes, upserts: upserts.length, deletes: deletes.length });
      const sobran = cadena.splice(0, Math.max(0, cadena.length - KEEP));
      for (const d of sobran) {
        const ruta = resolve(NEW_DIR, d.file);
        if (existsSync(ruta)) rmSync(ruta);
      }
      parte.deltas = cadena;

      const pct = parte.bytes ? ((bytes / parte.bytes) * 100).toFixed(2) : '0';
      console.log(
        `  ${etiqueta.padEnd(22)} ${String(upserts.length).padStart(6)} altas/cambios  ` +
          `${String(deletes.length).padStart(5)} bajas  ${(bytes / 1024).toFixed(1).padStart(8)} kB  ` +
          `(${pct}% de la parte, ${Date.now() - t0} ms)`,
      );
    }
  }

  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`\n  indice actualizado: ${indexPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
