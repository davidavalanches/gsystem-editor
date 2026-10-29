import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BankStore, bankPosition, slotLabel } from "../src/core/bank";
import { applyFavorite, captureFavorite, matchingFavorite } from "../src/core/favorites";
import { GLOBAL_PARAMS, formatGlobal, globalValue } from "../src/core/globals";
import { LEVELS_FIELD, presetLevels, writeBoostLevel } from "../src/core/levels";
import { BLOCKS, block, diffFields, fieldOffset, FIELD_COUNT, freq, readField, writeField } from "../src/core/params";
import {
  MODIFIER_FIELD, MODIFIER_SLOTS, UNASSIGNED, decodeModifier, encodeModifier, modifierTargets, writeModifier,
} from "../src/core/modifiers";
import {
  BLOCK_IDS, MidiParser, identityVersion, paramMessage, paramsRequest, parseParamMessage, parseParamValues, presetRequest,
  storeMessages,
} from "../src/core/protocol";
import { decodeSwitch, describeSwitch, encodeSwitch } from "../src/core/switches";
import { SqsFile, USER_BANK_KIND, readSyx, writeSyx } from "../src/core/sqs";
import {
  ChecksumError, PRESET_DATA_LEN, PRESET_DUMP_LEN, Preset, SysexError, bytesToNibbles, nibblesToBytes,
  splitSysex, userNumber,
} from "../src/core/sysex";

const hex = (s: string) => new Uint8Array(s.replace(/\s/g, "").match(/../g)!.map((b) => parseInt(b, 16)));
const BLANK = new Uint8Array(PRESET_DATA_LEN);

function makePreset(name = "Test", number = 100): Preset {
  const data = new Uint8Array(PRESET_DATA_LEN);
  data.fill(0x20, 0, 20);
  for (let i = 0; i < name.length; i++) data[i] = name.charCodeAt(i);
  for (let i = 0; i < 256; i++) data[20 + i] = i;
  return new Preset(number, data);
}

describe("sysex", () => {
  it("round-trips nibbles", () => {
    const raw = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(nibblesToBytes(bytesToNibbles(raw))).toEqual(raw);
    expect(() => nibblesToBytes(new Uint8Array([0x10, 0]))).toThrow(SysexError);
  });

  it("round-trips a dump", () => {
    const preset = makePreset("Test", 237);
    const msg = preset.toSysex();
    expect(msg.length).toBe(PRESET_DUMP_LEN);
    expect([...msg.slice(0, 8)]).toEqual([0xf0, 0, 0x20, 0x1f, 0x7f, 0x55, 0x20, 0x01]);
    expect(msg.slice(1, -1).every((b) => b < 0x80)).toBe(true);
    const parsed = Preset.fromSysex(msg);
    expect(parsed.number).toBe(237);
    expect(parsed.data).toEqual(preset.data);
    expect(parsed.checksumOk).toBe(true);
  });

  it("flags or rejects a checksum mismatch", () => {
    const msg = makePreset().toSysex();
    msg[msg.length - 2] = (msg[msg.length - 2] + 1) & 0x7f;
    expect(() => Preset.fromSysex(msg)).toThrow(ChecksumError);
    const lenient = Preset.fromSysex(msg, false);
    expect(lenient.checksumOk).toBe(false);
    expect(Preset.fromSysex(lenient.toSysex()).checksumOk).toBe(true);
  });

  it("masks and preserves name flag bits", () => {
    const data = makePreset("Eau trouble").data.slice();
    data[5] |= 0x80;
    data[19] |= 0x80;
    data[18] = 0x9c;
    const preset = new Preset(100, data);
    expect(preset.name).toBe("Eau trouble");
    const renamed = preset.withName("Clean");
    expect(renamed.name).toBe("Clean");
    expect(renamed.data[5] & 0x80).toBeTruthy();
    expect(renamed.data.slice(20)).toEqual(preset.data.slice(20));
  });

  it("splits sysex streams", () => {
    const a = makePreset().toSysex();
    const b = makePreset("x", 101).toSysex();
    const stream = new Uint8Array([0, 1, ...a, 0xf7, 1, 2, ...b]);
    expect(splitSysex(stream)).toEqual([a, b]);
    expect(userNumber(199)).toBe(299);
  });
});

describe("params", () => {
  it("covers the payload", () => {
    expect(FIELD_COUNT).toBe(165);
    expect(fieldOffset(FIELD_COUNT - 1) + 3).toBe(PRESET_DATA_LEN);
  });

  it.each([0, 1, -1, -25, 1800, -1200, (1 << 23) - 1, -(1 << 23)])("round-trips field value %i", (v) => {
    expect(readField(writeField(BLANK, 47, v), 47)).toBe(v);
  });

  it("has contiguous blocks that fit their slots", () => {
    let expected = 3;
    for (const b of BLOCKS) {
      expect(b.countField).toBe(expected);
      expected = b.firstField + b.size;
      for (let t = 0; t < Math.max(1, b.types.length); t++) {
        const data = b.hasType ? writeField(BLANK, b.firstField, t) : BLANK;
        expect(b.paramList(data).length).toBeLessThanOrEqual(b.size);
      }
    }
    expect(expected).toBe(125);
  });

  it("decodes the EQ snippet saved by Vyzor", () => {
    const snippet = [10, 0, 0, 253, 255, 255, 12, 0, 0, 10, 0, 0, 2, 0, 0, 31, 0, 0, 18, 0, 0, 251, 255, 255,
      48, 0, 0, 26, 0, 0, 1, 0, 0];
    const data = BLANK.slice();
    data.set(snippet, fieldOffset(114));
    const eq = block("eq");
    const values = Object.fromEntries(eq.fields(data).map(([f, p]) => [p.name, readField(data, f)]));
    expect(values.Gain1).toBe(-3);
    expect(values.EQ).toBe(1);
    expect(eq.enableField(data)).toBe(124);
  });

  it("follows the effect type", () => {
    const filt = block("filter");
    const wah = writeField(BLANK, filt.firstField, 5);
    expect(filt.effectType(wah)?.name).toBe("Auto Wah");
    expect(filt.fields(wah).at(-1)![1].name).toBe("AutoOn");
    expect(filt.enableField(wah)).toBe(filt.firstField + 1);
    expect(freq(34)).toBe("1.02 kHz");
    expect(freq(18)).toBe("160 Hz");
  });

  it("diffs fields", () => {
    const changed = writeField(writeField(BLANK, 3, 9), 100, -2);
    expect(diffFields(BLANK, changed)).toEqual([[3, 0, 9], [100, 0, -2]]);
  });
});

describe("protocol (captures from the unit)", () => {
  it("encodes parameter messages exactly like the unit", () => {
    const delayOff = hex("f000201f7f5522090001000000000000f7");
    expect(paramMessage(9, 1, 0)).toEqual(delayOff);
    expect(parseParamMessage(delayOff)).toEqual([9, 1, 0]);
    expect(paramMessage(BLOCK_IDS.reverb, 2, 39)).toEqual(hex("f000201f7f55220b0002000000000207f7"));
    const gate = hex("f000201f7f55220c00020f0f0f0f0e03f7");
    expect(parseParamMessage(gate)).toEqual([BLOCK_IDS.gate, 2, -29]);
    expect(paramMessage(BLOCK_IDS.gate, 2, -29)).toEqual(gate);
  });

  it("stores exactly like Vyzor's Sync captured on the unit", () => {
    const msgs = storeMessages(136, makePreset("Fragile", 300), 1);
    expect(msgs[0]).toEqual(hex("f000201f015522 01001d000000000001 f7"));
    expect(msgs[1]).toEqual(hex("f000201f01555700f7"));
    expect([...msgs[2].slice(0, 10)]).toEqual([0xf0, 0, 0x20, 0x1f, 0x01, 0x55, 0x20, 0x01, 0x01, 0x6c]); // n° 236
    expect(msgs[2].length).toBe(PRESET_DUMP_LEN);
    expect(msgs[3]).toEqual(hex("f000201f01555701f7"));
    expect(() => storeMessages(0, makePreset(), 0x7f)).toThrow(RangeError);
  });

  it("reads parameter ranges like Vyzor", () => {
    expect(paramsRequest(5, 3, 3, 1)).toEqual(hex("f000201f01554705000300 03f7"));
    expect(paramsRequest(5, 20, 224, 1)).toEqual(hex("f000201f015547050014 0160f7"));
    // The unit's answer: Tap Master, Tap Tempo 677 ms, tuner output.
    const answer = hex("f000201f7f552205 0003 000000000000 000000020a05 000000000001 f7");
    expect(parseParamValues(answer)).toEqual([[5, 3, 0], [5, 4, 677], [5, 5, 1]]);
    expect(parseParamMessage(answer)).toBeNull();
  });

  it("knows every block id", () => {
    expect(new Set(Object.keys(BLOCK_IDS))).toEqual(new Set(BLOCKS.map((b) => b.key)));
  });

  it("builds requests and reads the identity", () => {
    expect(presetRequest(100)).toEqual(hex("f000201f0055450100 64f7"));
    expect(identityVersion(hex("f07e7f060200201f550000000000 0405f7"))).toBe("4.05");
  });

  it("reassembles messages delivered in pieces", () => {
    const out: Uint8Array[] = [];
    const parser = new MidiParser((m) => out.push(m));
    const dump = makePreset().toSysex();
    parser.push(dump.slice(0, 300));
    parser.push([0xf8]);
    parser.push(dump.slice(300));
    parser.push([0xb0, 0x00]);
    parser.push([0x01, 0xc0, 0x0f]);
    expect(out.map((m) => m.length)).toEqual([1, PRESET_DUMP_LEN, 3, 2]);
    expect(out[1]).toEqual(dump);
  });
});

describe("modifiers", () => {
  // Sent by the unit (bulk 55 22 0D from parameter 20) for a preset whose stored bytes match.
  const UNIT_0D = [0x040404, 0x989804, 0x040404, 0x040404, 0x030303, 0x030303, 0x030303, 0xc8c800, 0xc8c800, 0x243002];

  it("decodes the unit's slot words", () => {
    expect(decodeModifier(0xc8c800)).toEqual(UNASSIGNED);
    expect(decodeModifier(0x243002)).toEqual({ source: 2, min: 0, mid: 12, max: 18 });
    // Vol on a slot, set from the unit's front panel.
    expect(decodeModifier(0xc918f1)).toEqual({ source: 1, min: 30, mid: 70, max: 100 });
    for (const raw of UNIT_0D) expect(encodeModifier(decodeModifier(raw)) & 0xffffff).toBe(raw);
  });

  it("stores slots in fields 125-162", () => {
    const data = writeModifier(BLANK, 13, { source: 2, min: 0, mid: 50, max: 100 });
    expect(readField(data, MODIFIER_FIELD + 13) & 0xffffff).toBe(0xc8c802);
    expect(MODIFIER_FIELD + MODIFIER_SLOTS).toBe(163);
  });

  it("lists the controllable parameters of the current types", () => {
    let data: Uint8Array = BLANK.slice();
    const setType = (key: string, type: number) => { data = writeField(data, block(key).firstField, type); };
    setType("pitch", 2); // Whammy: OutLev, Pitch
    setType("delay", 1); // Tape
    setType("reverb", 3); // Plate
    setType("mod", 0); // Classic Chorus
    const names = (key: string) => modifierTargets(data).filter((t) => t.key === key).map((t) => `${t.slot}:${t.name}`);
    expect(names("pitch")).toEqual(["12:OutLev", "13:Pitch"]);
    expect(names("delay")).toEqual(["20:Delay", "21:Fb", "22:Drive", "23:Fbhcut", "24:Fblcut", "25:Mix", "26:OutLev"]);
    expect(names("reverb")).toEqual(["30:Decay", "31:Lo Lev", "32:Mix", "33:OutLev"]);
    expect(names("mod")).toEqual(["7:Speed", "8:HiCut", "9:Mix", "10:OutLev"]);
    expect(modifierTargets(data, true).filter((t) => t.key === "novadrive").map((t) => t.slot)).toEqual([34, 35, 36, 37]);
  });
});

describe("levels", () => {
  const levels = (raw: number) => presetLevels(writeField(BLANK, LEVELS_FIELD, (raw << 8) >> 8));

  it("decodes the unit's own presets", () => {
    // "Chute - drive": the unit reported loop 2 on (insert lock was on, so its insert state was not recalled).
    expect(levels(0xc62508)).toMatchObject({ loops: [false, true, false, false], boost: false, boostLevel: 0, routing: 0 });
    // "Fragile - clean" as Vyzor sent it: insert and boost on, boost level 2.
    expect(levels(0xad202c)).toEqual({ loops: [false, false, false, false], insert: true, boost: true, boostLevel: 2, routing: 0 });
  });

  it("writes the boost level without touching the other bits", () => {
    const out = presetLevels(writeBoostLevel(writeField(BLANK, LEVELS_FIELD, (0xad202c << 8) >> 8), 7));
    expect(out).toEqual({ loops: [false, false, false, false], insert: true, boost: true, boostLevel: 7, routing: 0 });
  });

  it("reads a factory preset: loops off, 6 dB boost", () => {
    expect(levels(0x68)).toEqual({ loops: [false, false, false, false], insert: false, boost: false, boostLevel: 6, routing: 0 });
  });
});

describe("globals", () => {
  it("shows Input Gain in dB as the unit sends it", () => {
    const g = GLOBAL_PARAMS.get("1:3")!;
    expect(formatGlobal(g, globalValue(g, 8))).toBe("8 dB");
    expect(formatGlobal(g, globalValue(g, -8))).toBe("-8 dB");
    expect([g.lo, g.hi]).toEqual([-8, 18]);
  });
});

describe("favorites", () => {
  it("restores a block's type and parameters, keeping the preset's on/off", () => {
    const blk = block("reverb");
    const enable = (d: Uint8Array) => blk.enableField(d)!;
    let source = writeField(BLANK, blk.firstField, 1);
    source = writeField(source, enable(source), 1);
    source = writeField(source, blk.firstField + 3, 42);
    const fav = captureFavorite(source, "reverb");
    const target = writeField(writeField(BLANK, blk.firstField, 1), enable(source), 0);
    const out = applyFavorite(target, "reverb", fav);
    expect(readField(out, blk.firstField + 3)).toBe(42);
    expect(readField(out, enable(out))).toBe(0);
    expect(() => applyFavorite(BLANK, "comp", fav)).toThrow();
    // The block matches the favorite whatever its on/off state, and no longer once a value differs.
    expect(matchingFavorite(out, "reverb", [null, fav])).toBe(1);
    expect(matchingFavorite(writeField(out, blk.firstField + 3, 41), "reverb", [null, fav])).toBe(-1);
  });
});

describe("switches", () => {
  it("decodes the unit's assignments", () => {
    // Read from the unit: #1, #8, #11, #12, #15.
    expect(describeSwitch(decodeSwitch(1))).toBe("Filter (Toggle)");
    expect(describeSwitch(decodeSwitch(0x101))).toBe("Filter (Hold)");
    expect(describeSwitch(decodeSwitch(11))).toBe("Mod (Toggle)");
    expect(describeSwitch(decodeSwitch(277264))).toBe("Preset 38-5");
    expect(describeSwitch(decodeSwitch(202000))).toBe("Preset 00-4");
    expect(describeSwitch(decodeSwitch(65552))).toBe("Preset Current bank-2");
    expect(encodeSwitch(decodeSwitch(277264))).toBe(277264);
  });
});

describe("bank", () => {
  it("numbers banks and positions", () => {
    expect(bankPosition(6)).toEqual([1, 2]);
    expect(slotLabel(0)).toBe("00-1");
    expect(slotLabel(199)).toBe("39-5");
  });

  it("undoes and redoes slot changes", () => {
    const bank = new BankStore();
    bank.setSlots(new Map([[3, makePreset("A", 103)]]), "set");
    expect(bank.preset(3)?.name).toBe("A");
    expect(bank.undo.isClean).toBe(false);
    bank.undoLast();
    expect(bank.preset(3)).toBeNull();
    bank.redoLast();
    expect(bank.preset(3)?.name).toBe("A");
  });

  it("tracks presets to write into the unit", () => {
    const bank = new BankStore();
    const seen: (number[] | null)[] = [];
    bank.onChange = (slots) => seen.push(slots);
    bank.markPending([3, 7]);
    bank.markPending([7]);
    expect([...bank.pending]).toEqual([3, 7]);
    expect(seen).toEqual([[3, 7]]);
    bank.clearPending(3);
    expect([...bank.pending]).toEqual([7]);
    bank.load([], "autre banque");
    expect(bank.pending.size).toBe(0);
  });

  it("exports renumbered presets", () => {
    const bank = new BankStore();
    bank.load([null, makePreset("B", 150)], "t");
    const back = readSyx(bank.exportSyx());
    expect(back.map((p) => p.number)).toEqual([101]);
    expect(readSyx(writeSyx(back))[0].data).toEqual(back[0].data);
  });
});

// Real Vyzor banks, when present on this machine (not shipped with the repository).
const SAMPLES = process.env.GSYSTEM_SAMPLES ?? join(homedir(), "Documents/Psicraft/Vyzor G-System");
function sqsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sqsFiles(p) : n.toLowerCase().endsWith(".sqs") ? [p] : [];
  });
}
const FILES = sqsFiles(SAMPLES);

describe.skipIf(!FILES.length)("real .sqs banks", () => {
  it.each(FILES)("%s rewrites byte-identically", (path) => {
    const bytes = new Uint8Array(readFileSync(path));
    const sqs = new SqsFile(bytes);
    const bank = sqs.bank(USER_BANK_KIND);
    expect(bank.slotCount).toBe(200);
    sqs.userPresets().forEach((p, slot) => {
      if (p && p.checksumOk && p.userSlot === slot) sqs.setUserPreset(slot, p);
    });
    expect(sqs.toBytes()).toEqual(bytes);
  });
});
