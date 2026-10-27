/**
 * Effect favorites: up to four saved settings per effect block (type and every
 * parameter), recalled into any preset. The block's on/off state is the preset's
 * own and is kept when a favorite is loaded.
 */

import { block, readField, writeField } from "./params";

export const FAVORITE_COUNT = 4;

export interface Favorite {
  /** Effect type when saved, to tell the favorites apart. */
  label: string;
  /** Raw values of the block's fields, from its count field on. */
  values: number[];
}

export type Favorites = Record<string, (Favorite | null)[]>;

export function captureFavorite(data: Uint8Array, key: string): Favorite {
  const blk = block(key);
  return {
    label: blk.effectType(data)?.name ?? blk.label,
    values: blk.allFields().map((f) => readField(data, f)),
  };
}

export function applyFavorite(data: Uint8Array, key: string, fav: Favorite): Uint8Array {
  const blk = block(key);
  const fields = blk.allFields();
  if (fav.values.length !== fields.length) throw new RangeError(`favorite does not match the ${key} block`);
  const enable = blk.enableField(data);
  const on = enable === null ? null : readField(data, enable);
  let out = fields.reduce((d, f, i) => writeField(d, f, fav.values[i]), data);
  const newEnable = blk.enableField(out);
  if (on !== null && newEnable !== null) out = writeField(out, newEnable, on);
  return out;
}
