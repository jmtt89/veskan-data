/**
 * Tipos para `nutrients.mjs`. El modulo se escribe en JavaScript plano porque
 * lo comparten el app (TypeScript, por Vite) y la tuberia de datos (Node, sin
 * compilar). Una sola implementacion: si divergieran, el catalogo publicado y
 * lo que el app calcula al vuelo dejarian de coincidir.
 */
export type ClaveNutriente =
  | 'energy_kj' | 'energy_kcal' | 'fat' | 'saturated_fat' | 'trans_fat'
  | 'carbohydrates' | 'sugars' | 'fiber' | 'proteins' | 'salt' | 'sodium' | 'fvl';

/** Peldano de la escalera que resolvio el valor. */
export type Origen = string;

/** Un valor que consta en Open Food Facts pero es fisicamente imposible. */
export interface NutrienteImposible {
  nutriente: ClaveNutriente;
  /** Valor registrado, ya por 100 g y en unidad normalizada. */
  valor: number;
  unidad: string;
  /** Peldano del que salio. */
  origen: Origen;
  motivo: 'supera-maximo-fisico' | 'racion-incoherente';
  /** Peldano inferior que si dio un valor utilizable, si lo hubo. */
  sustituido: Origen | null;
}

export interface LecturaNutrientes {
  /** Valores por 100 g, en unidad normalizada (g, kJ, kcal, %). */
  valores: Record<ClaveNutriente, number | null>;
  origenes: Partial<Record<ClaveNutriente, Origen>>;
  /**
   * Valores imposibles que NO se usan para puntuar pero tampoco se descartan:
   * la ficha los muestra para que el usuario los compruebe en el envase.
   */
  imposibles: NutrienteImposible[];
  /** El producto declara no llevar tabla nutricional (`no_nutrition_data`). */
  sinDatos: boolean;
}

export declare const NUTRIENTES: Record<ClaveNutriente, {
  nid: string; respaldo?: string[]; comp?: string; unidad: string;
}>;

export declare function leerNutrientes(producto: unknown): LecturaNutrientes;
