/**
 * An "empty" preset: the G-System has no command to empty a user slot and only takes complete
 * presets, so clearing writes a neutral one instead. It is built from a valid preset (same layout,
 * accepted by the unit) with every effect, loop, insert and boost off, no modifiers, no NovaDrive
 * preset, and the name "Empty".
 */

import { block, SWITCH_BLOCKS, writeField } from "./params";
import { LEVEL_BITS, writeLevel } from "./levels";
import { MODIFIER_SLOTS, UNASSIGNED, writeModifier } from "./modifiers";
import { writeNovaPreset } from "./novadrive";
import { Preset, userNumber } from "./sysex";

export const EMPTY_NAME = "Empty";

export function emptyPreset(template: Preset, slot: number): Preset {
  let data: Uint8Array = template.data.slice();
  for (const key of SWITCH_BLOCKS) {
    const field = block(key).enableField(data);
    if (field !== null) data = writeField(data, field, 0);
  }
  for (const key of Object.keys(LEVEL_BITS)) if (key !== "relay") data = writeLevel(data, key, false);
  for (let m = 0; m < MODIFIER_SLOTS; m++) data = writeModifier(data, m, UNASSIGNED);
  data = writeNovaPreset(data, 0);
  return template.withData(data).withName(EMPTY_NAME).withNumber(userNumber(slot));
}

