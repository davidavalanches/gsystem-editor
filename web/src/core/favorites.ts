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
  /** Name given by the user, shown in place of the effect type. */
  name?: string;
  /** Raw values of the block's fields, from its count field on. */
  values: number[];
}

export type Favorites = Record<string, (Favorite | null)[]>;

export const FAVORITE_NAME_LEN = 16;

/** What a favorite shows: its own name, else the effect type it was saved with. */
export function favoriteName(fav: Favorite): string {
  return fav.name?.trim() || fav.label;
}

export function captureFavorite(data: Uint8Array, key: string, name?: string): Favorite {
  const blk = block(key);
  return {
    label: blk.effectType(data)?.name ?? blk.label,
    ...(name ? { name } : {}),
    values: blk.allFields().map((f) => readField(data, f)),
  };
}

/**
 * Index of the first favorite holding the block's current settings, or -1. The on/off
 * state is left out, as loading a favorite keeps the preset's own.
 */
export function matchingFavorite(data: Uint8Array, key: string, favorites: readonly (Favorite | null)[]): number {
  const blk = block(key);
  const fields = blk.allFields();
  const enable = blk.enableField(data);
  const values = fields.map((f) => readField(data, f));
  return favorites.findIndex((fav) => !!fav && fav.values.length === values.length
    && values.every((v, i) => fields[i] === enable || fav.values[i] === v));
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
