/**
 * NovaDrive (TC NDR-1 pedal on the G-System's NDR port): a preset only keeps which of the
 * pedal's 18 presets to recall; the pedal's own knobs and OD/DS settings stay in the pedal.
 *
 * Found in firmware 4.05 for interoperability: field 163 is an extension header,
 * 0xEDAB00 | number of words that follow (1); field 164 is the NovaDrive word, block 14
 * parameter 0, with the pedal preset (1-18, 0 = none) in bits 16-23. Bits 0-15 are not read
 * by the firmware (Vyzor writes 0xFFFF, the unit 0x0000) and are kept as found. Without the
 * header the unit takes the word as 0. On recall, with a pedal detected, the unit sends it
 * Program Change n - 1.
 */

import { readField, writeField } from "./params";

export const NOVA_HEADER_FIELD = 163;
export const NOVA_FIELD = 164;
export const NOVA_HEADER = 0xedab01;
/** Block id of the NovaDrive in 55 22 messages. */
export const NOVA_BLOCK_ID = 14;
export const NOVA_PRESETS = 18;

const signed = (raw: number) => (raw << 8) >> 8;
const hasHeader = (data: Uint8Array) => {
  const header = readField(data, NOVA_HEADER_FIELD) & 0xffffff;
  return (header & 0xffff00) === 0xedab00 && (header & 0xff) >= 1;
};

/** The NovaDrive word as the unit holds it (block 14 parameter 0). */
export function novaWord(data: Uint8Array): number {
  return hasHeader(data) ? readField(data, NOVA_FIELD) & 0xffffff : 0;
}

/** The pedal preset recalled with this preset: 1-18, or 0 for none. */
export function novaPreset(data: Uint8Array): number {
  const n = novaWord(data) >> 16;
  return n <= NOVA_PRESETS ? n : 0;
}

export function writeNovaWord(data: Uint8Array, word: number): Uint8Array {
  const out = hasHeader(data) ? data : writeField(data, NOVA_HEADER_FIELD, signed(NOVA_HEADER));
  return writeField(out, NOVA_FIELD, signed(word & 0xffffff));
}

export function writeNovaPreset(data: Uint8Array, preset: number): Uint8Array {
  const n = Math.max(0, Math.min(NOVA_PRESETS, Math.round(preset)));
  const low = hasHeader(data) ? readField(data, NOVA_FIELD) & 0xffff : 0;
  return writeNovaWord(data, (n << 16) | low);
}
