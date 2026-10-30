import { describe, expect, it } from "vitest";

import { LEVELS_FIELD, levelOn, presetLevels, presetRelays, relayText, writeLevel, writeRelay } from "../src/core/levels";
import { block, lfo, readField, writeField } from "../src/core/params";
import { presetSelectMessages } from "../src/core/protocol";
import { PRESET_DATA_LEN } from "../src/core/sysex";
import { NOVA_FIELD, NOVA_HEADER_FIELD, novaPreset, novaWord, writeNovaPreset } from "../src/core/novadrive";
import { noteQuarters, syncToTempo, writeTempoMs } from "../src/core/tempo";

const BLANK = new Uint8Array(PRESET_DATA_LEN);
const signed24 = (raw: number) => (raw << 8) >> 8;

/** Field of a parameter of a block under its current type. */
const field = (data: Uint8Array, key: string, name: string) => block(key).fields(data).find(([, p]) => p.name === name)![0];
/** Value of a Tempo list entry, by its label. */
const note = (data: Uint8Array, key: string, name: string, label: string) => {
  const p = block(key).fields(data).find(([, q]) => q.name === name)![1];
  return p.choices.indexOf(label) + p.choicesBase;
};

describe("relays", () => {
  const chute = writeField(BLANK, LEVELS_FIELD, signed24(0xc62508));

  it("reads relay settings A and B of the unit's preset", () => {
    expect(presetRelays(chute)).toEqual([6, 12]);
    expect(relayText(6)).toBe("OCCO");
    expect(relayText(12)).toBe("OOCC");
  });

  it("writes one relay setting without touching the other bits", () => {
    const out = writeRelay(chute, 1, 0b0001);
    expect(presetRelays(out)).toEqual([6, 1]);
    expect(presetLevels(out)).toEqual(presetLevels(chute));
    expect(readField(out, LEVELS_FIELD) & 0x0fffff).toBe(readField(chute, LEVELS_FIELD) & 0x0fffff);
  });

  // The unit sent relay switch (block 1 parameter 16) 1 with "Chute - drive"; Vyzor sent 0 with "Fragile - clean".
  it("reads the relay switch from bit 8", () => {
    expect(levelOn(chute, "relay")).toBe(true);
    expect(levelOn(writeField(BLANK, LEVELS_FIELD, signed24(0xad202c)), "relay")).toBe(false);
  });

  it("switches the relay without touching its settings", () => {
    const off = writeLevel(chute, "relay", false);
    expect(levelOn(off, "relay")).toBe(false);
    expect(presetRelays(off)).toEqual([6, 12]);
    expect(presetLevels(off)).toEqual(presetLevels(chute));
  });
});

describe("tempo sync", () => {
  it("measures note values in quarter notes", () => {
    expect(noteQuarters("1/4")).toBe(1);
    expect(noteQuarters("1/8D")).toBe(0.75);
    expect(noteQuarters("1/4T")).toBeCloseTo(2 / 3);
    expect(noteQuarters("1")).toBe(4);
    expect(noteQuarters("2")).toBe(8);
    expect(noteQuarters("Ignore")).toBeNull();
  });

  it("sets the delay time from the tap time and the note value", () => {
    let data = writeField(BLANK, field(BLANK, "delay", "TapTime"), 500);
    data = writeField(data, field(data, "delay", "Tempo"), note(data, "delay", "Tempo", "1/8D"));
    expect(readField(syncToTempo(data, "delay"), field(data, "delay", "Delay"))).toBe(375);
  });

  it("leaves the delay time alone when the tempo is ignored", () => {
    const data = writeField(writeField(BLANK, field(BLANK, "delay", "TapTime"), 500), field(BLANK, "delay", "Delay"), 123);
    expect(readField(syncToTempo(data, "delay"), field(data, "delay", "Delay"))).toBe(123);
  });

  it("sets a modulation speed from the tap time", () => {
    let data = writeField(BLANK, field(BLANK, "mod", "Tap"), 500);
    data = writeField(data, field(data, "mod", "Tempo"), note(data, "mod", "Tempo", "1/4"));
    const speed = readField(syncToTempo(data, "mod"), field(data, "mod", "Speed"));
    // 2 Hz, to the nearest step of the 1/24-octave scale.
    expect(lfo(speed)).toBe("2.02 Hz");
  });

  it("follows a new preset tempo", () => {
    let data = writeField(BLANK, field(BLANK, "delay", "Tempo"), note(BLANK, "delay", "Tempo", "1/4"));
    data = writeTempoMs(data, 600);
    expect(readField(data, field(data, "delay", "Delay"))).toBe(600);
  });
});

describe("preset recall", () => {
  it("sends Bank Select and Program Change on the unit's channel", () => {
    expect(presetSelectMessages(0, 1).map((m) => [...m])).toEqual([[0xb0, 0, 1], [0xc0, 0]]);
    expect(presetSelectMessages(150, 3).map((m) => [...m])).toEqual([[0xb2, 0, 2], [0xc2, 50]]);
  });
});

describe("novadrive", () => {
  it("reads the NDR-1 preset only behind the extension header", () => {
    const vyzor = writeField(writeField(BLANK, NOVA_HEADER_FIELD, signed24(0xedab01)), NOVA_FIELD, signed24(0x12ffff));
    expect(novaPreset(vyzor)).toBe(18);
    expect(novaWord(vyzor)).toBe(0x12ffff);
    expect(novaPreset(writeField(BLANK, NOVA_FIELD, signed24(0x12ffff)))).toBe(0);
  });

  it("writes the header and keeps the low bits", () => {
    const set = writeNovaPreset(BLANK, 3);
    expect(readField(set, NOVA_HEADER_FIELD) & 0xffffff).toBe(0xedab01);
    expect(novaWord(set)).toBe(0x030000);
    const vyzor = writeField(writeField(BLANK, NOVA_HEADER_FIELD, signed24(0xedab01)), NOVA_FIELD, signed24(0x01ffff));
    expect(novaWord(writeNovaPreset(vyzor, 0))).toBe(0x00ffff);
  });
});
