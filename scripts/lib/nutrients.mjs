/**
 * Lectura de nutrientes segun el esquema oficial de Open Food Facts.
 *
 * El volcado NO trae lo mismo que la API, y la razon esta documentada. En
 * `docs/api/ref/schemas/product_nutrition.yaml` los campos `<n>_100g`,
 * `<n>_serving` y `<n>_value` estan marcados `readOnly: true` y descritos como
 * CALCULADOS:
 *
 *   "<n>_100g: The normalized value of the nutrient for 100g (or 100ml for
 *    liquids), in a standard unit [...] This is computed from the `nutrient`
 *    property, the serving size (if `nutrient` is per serving), and the
 *    `nutrient`_unit field."
 *
 * Los unicos campos de ORIGEN son `<n>` (sin sufijo) y `<n>_unit`, que se
 * interpretan segun `nutrition_data_per`:
 *
 *   "nutrition_data_per [...] This is essential to understand if
 *    `<nutrient>_value` and `<nutrient>` values in `nutriments` applies for a
 *    serving or for 100g."
 *
 * En el volcado los campos calculados faltan a menudo. Leer solo `_100g` -como
 * haciamos- tira la informacion que si persiste. De ahi esta escalera.
 *
 * Cada peldano devuelve tambien DE DONDE salio el valor, para poder medir
 * cuanto aporta cada uno en vez de suponerlo.
 */

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Factores a gramos. La lista de unidades permitidas del esquema incluye
 * grafias en chino y ruso, asi que no basta con `g`/`mg`.
 * Los volumenes se tratan a 1 g/ml, que es la equivalencia que usa el propio
 * Open Food Facts para liquidos ("100g or 100ml").
 */
const A_GRAMOS = {
  g: 1, gr: 1, gram: 1, grams: 1,
  mg: 1e-3, 'мг': 1e-3, '毫克': 1e-3,
  mcg: 1e-6, 'µg': 1e-6, 'μg': 1e-6, ug: 1e-6,
  kg: 1000, 'кг': 1000, '公斤': 1000, '斤': 500,
  oz: 28.349523125, lb: 453.59237,
  ml: 1, 'мл': 1, cl: 10, 'кл': 10, dl: 100, 'дл': 100,
  l: 1000, 'л': 1000, '公升': 1000, 'fl oz': 29.5735295625,
};

const KJ_POR_KCAL = 4.184;

const mul = (v, f) => (v === null ? null : v * f);

/**
 * Nutrientes que necesitamos, con su unidad normalizada y su equivalente en
 * `nutriscore_data.components` (ids del esquema: energy, sugars, saturated_fat,
 * salt, fiber, fruits_vegetables_legumes).
 */
export const NUTRIENTES = {
  energy_kj: { nid: 'energy-kj', respaldo: ['energy'], comp: 'energy', unidad: 'kJ' },
  energy_kcal: { nid: 'energy-kcal', unidad: 'kcal' },
  fat: { nid: 'fat', unidad: 'g' },
  saturated_fat: { nid: 'saturated-fat', comp: 'saturated_fat', unidad: 'g' },
  trans_fat: { nid: 'trans-fat', unidad: 'g' },
  carbohydrates: { nid: 'carbohydrates', unidad: 'g' },
  sugars: { nid: 'sugars', comp: 'sugars', unidad: 'g' },
  fiber: { nid: 'fiber', comp: 'fiber', unidad: 'g' },
  proteins: { nid: 'proteins', comp: 'proteins', unidad: 'g' },
  salt: { nid: 'salt', comp: 'salt', unidad: 'g' },
  sodium: { nid: 'sodium', unidad: 'g' },
  fvl: {
    nid: 'fruits-vegetables-legumes-estimate-from-ingredients',
    // El campo de legumbres es el que pide el Nutri-Score de 2023; el de frutos
    // secos era el del de 2021. Se usa como respaldo, no por equivalencia -no
    // lo son- sino porque en muchos productos es lo unico que hay, y acercarse
    // con el dato de 2021 informa mas que dejarlo en nulo. Queda anotado como
    // origen para que se vea de donde salio.
    respaldo: [
      'fruits-vegetables-nuts-estimate-from-ingredients',
      'fruits-vegetables-nuts',
    ],
    comp: 'fruits_vegetables_legumes',
    unidad: '%',
  },
};

/** Convierte `valor` desde `unidad` hasta la unidad normalizada del nutriente. */
function convertir(valor, unidad, destino) {
  if (valor === null) return null;
  const u = String(unidad ?? '').trim().toLowerCase();
  if (!u) return destino === 'g' || destino === '%' ? valor : null;

  if (destino === 'kJ') {
    if (u === 'kj') return valor;
    if (u === 'kcal') return valor * KJ_POR_KCAL;
    return null;
  }
  if (destino === 'kcal') {
    if (u === 'kcal') return valor;
    if (u === 'kj') return valor / KJ_POR_KCAL;
    return null;
  }
  if (destino === '%') return u === '%' || u === '% vol' ? valor : null;

  // `dv` (ingesta diaria recomendada) depende del nutriente y del pais: no se
  // puede convertir de forma reproducible, asi que se descarta.
  const f = A_GRAMOS[u];
  return f === undefined ? null : valor * f;
}

/**
 * Decide si se puede confiar en escalar por racion.
 *
 * El factor `100 / serving_quantity` es uno solo para todo el producto: si al
 * aplicarlo a la energia sale algo fisicamente imposible, el factor esta mal, y
 * entonces lo esta para TODOS los nutrientes, no solo para la energia. Sin esta
 * comprobacion se daba el caso de rechazar 117.200 kJ/100 g y aceptar a la vez
 * 75 g de sal por 100 g del mismo producto, viniendo ambos del mismo calculo.
 *
 * La energia sirve de testigo porque es el unico nutriente con un techo
 * ajustado (la grasa pura, ~3.770 kJ/100 g); los demas solo topan en 100 g, que
 * casi nada supera aunque el escalado sea un disparate.
 */
function racionFiable(n, racion, por) {
  if (!racion) return false;
  const escala = 100 / racion;
  const kj = por === 'serving' ? [n['energy-kj'], n['energy']] : [];
  kj.push(n['energy-kj_serving'], n['energy_serving']);
  for (const v of kj) {
    const x = num(v);
    if (x !== null) return x * escala <= COTAS.kJ;
  }
  const kcal = por === 'serving' ? [n['energy-kcal']] : [];
  kcal.push(n['energy-kcal_serving']);
  for (const v of kcal) {
    const x = num(v);
    if (x !== null) return x * escala <= COTAS.kcal;
  }
  // Sin energia con que contrastar no hay contradiccion que detectar.
  return true;
}

/** Indexa `nutriscore_data.components` por id. Vale para el formato 2023. */
function componentes(p) {
  const c = p?.nutriscore_data?.components;
  const fuera = new Map();
  for (const lado of ['negative', 'positive']) {
    for (const x of Array.isArray(c?.[lado]) ? c[lado] : []) {
      if (x && typeof x.id === 'string') fuera.set(x.id, x);
    }
  }
  return fuera;
}

/**
 * Cotas fisicas por unidad normalizada. No son heuristicas de afinado: nada
 * puede llevar mas de 100 g de un nutriente por cada 100 g de producto, y la
 * grasa pura -lo mas energetico que existe- ronda 37 kJ/g, o sea 3.700 kJ/100 g.
 *
 * Sirven para descartar peldanos que producen disparates. Se vio en la
 * verificacion contra el volcado: bolsitas de te con `serving_quantity` de 1 g
 * daban 117.200 kJ/100 g al escalar por racion. Que Open Food Facts NO publique
 * `_100g` para esos productos -pudiendo calcularlo, segun su propio esquema- es
 * la senal de que descarto esos datos a proposito. Reproducirlos seria peor que
 * no tener nada.
 */
const COTAS = { g: 100, kJ: 4000, kcal: 960, '%': 100 };

const dentroDeCota = (valor, unidad) => {
  const tope = COTAS[unidad];
  return valor !== null && valor >= 0 && (tope === undefined || valor <= tope);
};

/**
 * Lee un nutriente recorriendo la escalera documentada.
 *
 * El orden no es arbitrario: primero lo que YA viene por 100 g y no exige
 * ninguna cuenta, despues lo que hay que escalar por racion. Cada candidato se
 * comprueba contra las cotas fisicas y, si no pasa, se sigue bajando.
 *
 * Devuelve `{ valor, origen }`; `origen` es el peldano que lo resolvio.
 */
export function leerNutriente(p, clave, ctx) {
  const def = NUTRIENTES[clave];
  if (!def) throw new Error(`nutriente desconocido: ${clave}`);
  const { n, por, racion, comps } = ctx;
  const nids = [def.nid, ...(def.respaldo ?? [])];
  const por100g = por === '100g';
  // La escala se calcula SIEMPRE que haya racion. Si el factor no es de fiar,
  // los candidatos que salgan de el no se aceptan, pero si se registran: el
  // valor imposible es informacion que la ficha muestra, no ruido que tirar.
  const escala = racion ? 100 / racion : null;

  /**
   * Candidatos en orden de fiabilidad decreciente, como `[origen, leer, fiable]`.
   * Perezosos: solo se evalua hasta el primero aceptable.
   */
  const candidatos = [];

  // 1. `_100g`: normalizado y por 100 g por definicion. Es calculado, y en el
  //    volcado falta a menudo, pero cuando esta es el mejor dato que hay.
  for (const nid of nids) candidatos.push(['100g', () => num(n[`${nid}_100g`]), true]);

  // 2. Sin sufijo: "What was entered in normalised unit", ya en la unidad
  //    normalizada. Solo se usa directo si la base declarada son 100 g.
  if (por100g) for (const nid of nids) candidatos.push(['sin-sufijo', () => num(n[nid]), true]);

  // 3. `_value` + `_unit`: lo que tecleo quien lo aporto, en su propia unidad.
  if (por100g) {
    for (const nid of nids) {
      candidatos.push(['value', () => convertir(num(n[`${nid}_value`]), n[`${nid}_unit`], def.unidad), true]);
    }
  }

  // 4. `nutriscore_data.components`: por 100 g por construccion, porque el
  //    Nutri-Score se calcula siempre sobre 100 g, y ya paso por el calculo de
  //    Open Food Facts. Va ANTES que escalar por racion justamente por eso: no
  //    exige ninguna cuenta nuestra. Es ademas el unico peldano que queda
  //    cuando `nutriments` viene vacio del todo.
  if (def.comp) {
    candidatos.push([
      'nutriscore',
      () => {
        const c = comps.get(def.comp);
        return convertir(num(c?.value), c?.unit ?? def.unidad, def.unidad);
      },
      true,
    ]);
  }

  // 5. Escalado por racion. Ultimo recurso: `serving_quantity` es a su vez un
  //    campo calculado y arrastra los errores de `serving_size`.
  if (escala) {
    const fiable = ctx.racionFiable;
    for (const nid of nids) {
      if (!por100g) candidatos.push(['sin-sufijo-racion', () => mul(num(n[nid]), escala), fiable]);
      candidatos.push(['serving', () => mul(num(n[`${nid}_serving`]), escala), fiable]);
      if (!por100g) {
        candidatos.push([
          'value-racion',
          () => mul(convertir(num(n[`${nid}_value`]), n[`${nid}_unit`], def.unidad), escala),
          fiable,
        ]);
      }
    }
  }

  // Primer candidato descartado, para poder decir en la ficha QUE valor consta
  // y por que no se usa. Se guarda el primero porque los candidatos van de mas
  // a menos fiable: es el que el usuario veria en Open Food Facts.
  let descartado = null;

  for (const [origen, leer, fiable] of candidatos) {
    const valor = leer();
    if (valor === null) continue;
    const cabe = dentroDeCota(valor, def.unidad);
    if (cabe && fiable) return { valor, origen, descartado };
    if (!descartado) {
      descartado = { valor, origen, unidad: def.unidad, motivo: cabe ? 'racion-incoherente' : 'supera-maximo-fisico' };
    }
  }
  return { valor: null, origen: null, descartado };
}

/**
 * Lee de una vez todos los nutrientes de un producto.
 * Devuelve los valores por 100 g y un recuento de origenes.
 */
export function leerNutrientes(p) {
  const ctx = {
    n: p?.nutriments ?? {},
    /**
     * SUPOSICION, no dato: el esquema declara el enum `serving | 100g` pero no
     * dice cual rige si el campo falta. Se asume 100 g, que es el valor por
     * defecto del formulario de Open Food Facts y la base habitual del
     * etiquetado. El riesgo es real -si la exportacion pierde este campo igual
     * que pierde los `_100g`, un valor por racion se leeria como por 100 g y
     * quedaria INFRAESTIMADO, que es la direccion que las cotas fisicas no
     * detectan-, pero solo afecta a productos que ademas no tengan `_100g` ni
     * `nutriscore_data`. Si algun dia se mide que es frecuente, habria que
     * preferir dejarlo en nulo antes que suponer.
     */
    por: p?.nutrition_data_per === 'serving' ? 'serving' : '100g',
    racion: num(p?.serving_quantity),
    comps: componentes(p),
  };
  ctx.racionFiable = racionFiable(ctx.n, ctx.racion, ctx.por);

  const valores = {};
  const origenes = {};
  /**
   * Valores que constan en Open Food Facts pero no se pueden usar. No se
   * descartan en silencio: la ficha los muestra diciendo que son imposibles y
   * que hay que mirar el envase, que informa mas que un hueco vacio.
   */
  const imposibles = [];
  for (const clave of Object.keys(NUTRIENTES)) {
    const { valor, origen, descartado } = leerNutriente(p, clave, ctx);
    valores[clave] = valor;
    if (origen) origenes[clave] = origen;
    if (descartado) {
      // Se anota aunque un peldano inferior haya dado un valor bueno: que Open
      // Food Facts tenga registrado un imposible es informacion util igual, y
      // `sustituido` dice si el hueco quedo cubierto o no.
      imposibles.push({ nutriente: clave, ...descartado, sustituido: origen });
    }
  }

  // Coherencia entre energia, sal y sodio: son la misma magnitud expresada de
  // dos formas, asi que una completa a la otra en vez de quedar en nulo. La
  // conversion tambien pasa por las cotas, porque un sodio disparatado daria
  // una sal disparatada.
  const derivar = (destino, fuente, factor, sufijo) => {
    if (valores[destino] !== null || valores[fuente] === null) return;
    const v = valores[fuente] * factor;
    if (!dentroDeCota(v, NUTRIENTES[destino].unidad)) return;
    valores[destino] = v;
    origenes[destino] = `${origenes[fuente]}:${sufijo}`;
  };
  derivar('energy_kj', 'energy_kcal', KJ_POR_KCAL, 'kcal');
  derivar('energy_kcal', 'energy_kj', 1 / KJ_POR_KCAL, 'kj');
  derivar('salt', 'sodium', 2.5, 'sodio');
  derivar('sodium', 'salt', 1 / 2.5, 'sal');

  return {
    valores,
    origenes,
    imposibles,
    // "no_nutrition_data: on" es la ausencia LEGITIMA, documentada como
    // frecuente ("thousands of products"). No es un fallo que haya que tapar.
    sinDatos: p?.no_nutrition_data === 'on' || p?.no_nutrition_data === true,
  };
}
