"""Preset parameter layout.

A preset's 516 data bytes are a 21-byte name followed by 165 fields of 3 bytes
(signed 24-bit little-endian). Fields 0-124 hold the effect blocks; fields
125-164 hold byte-packed data (routing, levels, switch/pedal assignments).

Each effect block is stored as ``[parameter count][parameters...]`` in a slot of
fixed size, in this order: Comp, Filter, Mod, Pitch, Reverb, Gate, Delay, EQ.
Parameter 0 of a block is its effect type (when it has one), parameter 1 its
on/off switch. Which parameters exist depends on the effect type.

Names, ranges and value lists come from the parameter tables of G-System
firmware 4.02 and were cross-checked against the factory presets and the
user's banks; unit conversions come from the G-System manual.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .sysex import PRESET_DATA_LEN

FIELDS_OFFSET = 21
FIELD_COUNT = (PRESET_DATA_LEN - FIELDS_OFFSET) // 3
NUMERIC_FIELDS = 125

CONFIRMED, LIKELY, GUESS = "confirmé", "probable", "hypothèse"


def field_offset(index: int) -> int:
    if not 0 <= index < FIELD_COUNT:
        raise IndexError(f"field {index} out of range")
    return FIELDS_OFFSET + 3 * index


def read_field(data: bytes, index: int) -> int:
    off = field_offset(index)
    value = data[off] | data[off + 1] << 8 | data[off + 2] << 16
    return value - (1 << 24) if value & 0x800000 else value


def write_field(data: bytes, index: int, value: int) -> bytes:
    if not -(1 << 23) <= value < 1 << 23:
        raise ValueError(f"value {value} does not fit in 24 bits")
    off = field_offset(index)
    raw = (value & 0xFFFFFF).to_bytes(3, "little")
    return data[:off] + raw + data[off + 3 :]


# Value display

def _hz(hz: float) -> str:
    return f"{hz / 1000:.2f} kHz" if hz >= 1000 else f"{hz:.0f} Hz"


def freq(i: int) -> str:
    """Filter frequencies: 20 Hz to 20 kHz in sixth-octave steps."""
    return _hz(20 * 2 ** (i / 6))


def lfo(i: int) -> str:
    """Modulation speed: 0.05 Hz to 20 Hz in 1/24-octave steps."""
    hz = 0.05 * 2 ** (i / 24)
    return f"{hz:.2f} Hz" if hz < 10 else f"{hz:.1f} Hz"


def unit(suffix: str) -> Callable[[int], str]:
    return lambda v: f"{v} {suffix}"


def scaled(factor: float, suffix: str, digits: int = 1) -> Callable[[int], str]:
    return lambda v: f"{v * factor:.{digits}f} {suffix}"


DB, MS, PCT, CENTS = unit("dB"), unit("ms"), unit("%"), unit("cents")
ONOFF = ("Off", "On")
TEMPO = ("Ignore", "2", "1", "1/2D", "1/2", "1/2T", "1/4D", "1/4", "1/4T", "1/8D", "1/8", "1/8T",
         "1/16D", "1/16", "1/16T", "1/32D", "1/32", "1/32T")
DELAY_TEMPO = ("Ignore",) + TEMPO[2:]
TIMES = ("0.3 ms", "0.5 ms", "0.7 ms", "1.0 ms", "1.4 ms", "2.0 ms", "3.0 ms", "5.0 ms", "7.0 ms", "10 ms",
         "14 ms", "20 ms", "30 ms", "50 ms", "70 ms", "100 ms", "140 ms", "200 ms", "300 ms", "500 ms",
         "700 ms", "1.0 s", "1.4 s", "2.0 s")
VOWELS = ("HEAT", "HIT", "HEAD", "HAD", "BUT", "FATHER", "ALL", "BOOT", "FOOT", "BIRD")


@dataclass(frozen=True)
class Param:
    name: str
    lo: int
    hi: int
    choices: tuple[str, ...] = ()
    fmt: Callable[[int], str] | None = None
    # Value list starting at an offset (e.g. release times start at index 13).
    choices_base: int = 0

    def format(self, value: int) -> str:
        if self.choices:
            i = value - self.choices_base
            return self.choices[i] if 0 <= i < len(self.choices) else str(value)
        return self.fmt(value) if self.fmt else str(value)

    @property
    def is_switch(self) -> bool:
        return self.choices == ONOFF


def P(name, lo, hi, fmt=None):
    return Param(name, lo, hi, fmt=fmt)


def E(name, choices, lo=0, base=0):
    return Param(name, lo, lo + len(choices) - 1 if not base else len(choices) - 1, tuple(choices), choices_base=base)


TAP = P("Tap", 100, 3000, MS)
OUTLEV = P("OutLev", -100, 0, DB)
MIX = P("Mix", 0, 100, PCT)
ENABLE = E("Enable", ONOFF)

FILTER_WAH = (ENABLE, TAP, E("Tempo", TEMPO), P("Sense", 0, 10), E("Resp", ("Slow", "Fast")),
              P("Speed", 0, 208, lfo), E("Shape", ("Tri", "Sine")), P("Sweep", 0, 100, PCT),
              E("Range", ("Low", "High")), OUTLEV, E("AutoOn", ("Off", "0.3s", "0.5s", "1s", "3s", "5s", "10s", "Inf")))
FILTER_RES = (ENABLE, TAP, E("Tempo", TEMPO), E("Style", ("2nd", "4th")), P("Sense", 0, 10),
              E("Resp", ("Slow", "Fast")), P("Fmax", 34, 54, freq), P("Hicut", 18, 57, freq),
              P("Resnce", 0, 100, PCT), P("Speed", 0, 208, lfo), E("Shape", ("Tri", "Sine")), OUTLEV)
FILTER_FORMANT = (ENABLE, TAP, E("Tempo", TEMPO), E("Low", VOWELS), E("Mid", VOWELS), E("High", VOWELS),
                  P("Sweep", 0, 100, PCT), P("Bright", 0, 100, PCT), P("Resnce", 0, 100, PCT), P("Sense", 0, 10),
                  E("Resp", ("Slow", "Fast")), P("Speed", 0, 208, lfo), E("Shape", ("Tri", "Sine")), OUTLEV)

MOD_CHORUS = (ENABLE, TAP, E("Tempo", TEMPO), P("Speed", 0, 208, lfo), P("Depth", 0, 100, PCT),
              P("HiCut", 0, 60, freq), MIX, OUTLEV, P("Cho Dly", 0, 500, scaled(0.1, "ms")),
              E("Ratio", ONOFF), E("PhaRev", ONOFF), P("FeedB", -100, 100, PCT), P("FB Cut", 0, 60, freq))
MOD_PHASER = (ENABLE, TAP, E("Tempo", TEMPO), P("Speed", 0, 208, lfo), P("Depth", 0, 100, PCT),
              P("Fb", -100, 100, PCT), E("Range", ("Low", "High")), E("Rev", ONOFF), MIX, OUTLEV)
MOD_UNIVIBE = (ENABLE, E("BpMode", ("Delay", "Direct")), E("Tempo1", TEMPO), E("Tempo2", TEMPO),
               P("Depth", 0, 100, PCT), P("Speed1", 38, 184, lfo), P("Speed2", 38, 184, lfo),
               P("Attack", 50, 5000, MS), P("Releas", 50, 5000, MS), E("Select", ("Speed1", "Speed2")),
               E("PhaRev", ONOFF), MIX, OUTLEV)
MOD_TREMOLO = (ENABLE, TAP, E("Tempo", TEMPO), P("Speed", 0, 368), P("Depth", 0, 100, PCT),
               E("Type", ("Soft", "Hard")), P("Width", 0, 100, PCT), P("Hi Cut", 0, 60, freq), MIX, OUTLEV)

INTERVALS = ("-13", "-12", "-11", "-10", "-9", "-Oct1", "-7", "-6", "-5", "-4", "-3", "-2", "Unison",
             "2", "3", "4", "5", "6", "7", "Oct1", "9", "10", "11", "12", "13")
PITCH_COMMON_TAIL = (MIX, OUTLEV, E("Dir", ("Down", "Up")))
PITCH_SHIFTER = (ENABLE, P("Voice1", -1200, 1200, CENTS), P("Voice2", -1200, 1200, CENTS),
                 P("Pan1", -50, 50), P("Pan2", -50, 50), P("Delay1", 0, 350, MS), P("Delay2", 0, 350, MS),
                 P("Fb1", 0, 100, PCT), P("Fb2", 0, 100, PCT), P("Level1", -100, 0, DB),
                 P("Level2", -100, 0, DB), *PITCH_COMMON_TAIL, E("Range", ("1 Oct", "2 Oct")),
                 P("Pitch", 0, 100, PCT), P("VoiceL", -100, 100), P("VoiceR", -100, 100))
PITCH_INTELLIGENT = (ENABLE, Param("Voice1", -12, 12, INTERVALS, choices_base=-12),
                     Param("Voice2", -12, 12, INTERVALS, choices_base=-12),
                     P("Pan1", -50, 50), P("Pan2", -50, 50), P("Delay1", 0, 50, MS), P("Delay2", 0, 50, MS),
                     E("Key", ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")),
                     E("Scale", ("Ionian", "Dorian", "Phrygi", "Lydian", "MixoLy", "Aeolia", "Locria", "PntMin",
                                 "PntMaj", "Blues", "DimHlf", "DimWhl", "Whole", "MelMin", "HrmMin", "SupLoc",
                                 "Lyd b7", "PhryMa")),
                     P("Level1", -100, 0, DB), P("Level2", -100, 0, DB), *PITCH_COMMON_TAIL,
                     E("Mode", ("Step", "Smooth")), P("Pitch", 0, 100, PCT), P("VoiceL", -100, 100),
                     P("VoiceR", -100, 100))
# The doubler's parameter names are not in the firmware tables.
PITCH_DOUBLER = (ENABLE, P("Pitch", -20, 20), P("Param 3", -20, 20), P("Param 4", -50, 50),
                 P("Param 5", -50, 50), P("Delay", 3, 60, MS), P("Param 7", 1, 20), P("Param 8", 0, 100),
                 P("Param 9", 0, 100), P("Param 10", -100, 0, DB), P("Param 11", -100, 0, DB),
                 P("Param 12", 0, 100), OUTLEV, E("Side", ("Left", "Right")))

DELAY = (ENABLE, P("Delay", 0, 1800, MS), P("Delay1", 0, 1800, MS), P("Delay2", 0, 1800, MS),
         E("Tempo", DELAY_TEMPO), E("Tempo1", DELAY_TEMPO), E("Tempo2", DELAY_TEMPO), P("TapTime", 100, 3000, MS),
         P("Fb", 0, 120, PCT), P("Fb1", 0, 120, PCT), P("Fb2", 0, 120, PCT), P("Drive", 0, 24, DB),
         P("Drive1", 0, 24, DB), P("Drive2", 0, 24, DB), P("Fbhcut", 0, 60, freq), P("Fblcut", 0, 60, freq),
         P("Pan1", -50, 50), P("Pan2", -50, 50), MIX, OUTLEV, P("Width", 0, 100, PCT), P("Offset", 0, 200, MS),
         P("Sense", -50, 0, DB), P("Damp", 0, 100, DB), P("Rel", 20, 1000, MS), P("Delay", 50, 800, MS))

REVERB = (ENABLE, P("Decay", 1, 200, scaled(0.1, "s")), P("PreDly", 0, 100, MS),
          E("Shape", ("Round", "Curved", "Square")),
          E("Size", ("Box", "Tiny", "Small", "Medium", "Large", "XL", "Grand", "Huge")),
          E("Hi Col", ("Wool", "Warm", "Real", "Clear", "Bright", "Crisp", "Glass")), P("Hi Lev", -25, 25),
          E("Lo Col", ("Thick", "Round", "Real", "Light", "Tight", "Thin", "NoBass")), P("Lo Lev", -25, 25),
          P("Early", -100, 0, DB), P("RevLev", -100, 0, DB), P("Diff", -25, 25), MIX, OUTLEV)

COMP = (E("Comp", ONOFF), P("Thres", -40, 0, DB),
        E("Ratio", ("Off", "1.12:1", "1.25:1", "1.40:1", "1.60:1", "1.80:1", "2.0:1", "2.5:1", "3.2:1",
                    "4.0:1", "5.6:1", "8.0:1", "16:1", "32:1", "64:1", "inf:1")),
        Param("Attack", 0, 16, TIMES), Param("Releas", 13, 23, TIMES), P("Gain", -100, 12, DB),
        P("Drive", 1, 20), P("Resp", 1, 10))

GATE = (E("NG", ONOFF), E("Mode", ("Hard", "Soft")), P("Thres", -60, 0, DB), P("Damp", 0, 90, DB),
        P("Speed", 3, 200, unit("dB/s")))

EQ = (P("Gain1", -12, 12, DB), P("Freq1", 0, 60, freq), P("Width1", 0, 39, scaled(0.1, "oct")),
      P("Gain2", -12, 12, DB), P("Freq2", 0, 60, freq), P("Width2", 0, 39, scaled(0.1, "oct")),
      P("Gain3", -12, 12, DB), P("Freq3", 0, 60, freq), P("Width3", 0, 39, scaled(0.1, "oct")), E("EQ", ONOFF))


@dataclass(frozen=True)
class EffectType:
    name: str
    params: tuple[Param, ...]  # parameters 1.. (parameter 0 is the type itself)


@dataclass(frozen=True)
class Block:
    key: str
    label: str
    count_field: int
    size: int  # parameter slots reserved in the SysEx layout
    types: tuple[EffectType, ...] = ()
    params: tuple[Param, ...] = ()  # for blocks without a type parameter
    enable_name: str = "Enable"

    @property
    def first_field(self) -> int:
        return self.count_field + 1

    @property
    def has_type(self) -> bool:
        return bool(self.types)

    def param_list(self, data: bytes) -> tuple[Param, ...]:
        """Parameters in slot order for the effect type currently stored."""
        if not self.has_type:
            return self.params
        t = self.effect_type(data)
        return (Param("Type", 0, len(self.types) - 1, tuple(x.name for x in self.types)),) + (t.params if t else ())

    def effect_type(self, data: bytes) -> EffectType | None:
        if not self.has_type:
            return None
        value = read_field(data, self.first_field)
        return self.types[value] if 0 <= value < len(self.types) else None

    def fields(self, data: bytes) -> list[tuple[int, Param]]:
        return [(self.first_field + i, p) for i, p in enumerate(self.param_list(data))]

    def enable_field(self, data: bytes) -> int | None:
        for f, p in self.fields(data):
            if p.name == self.enable_name:
                return f
        return None

    def all_fields(self) -> list[int]:
        return list(range(self.count_field, self.first_field + self.size))


def family(names: tuple[str, ...], params: tuple[Param, ...]) -> tuple[EffectType, ...]:
    return tuple(EffectType(n, params) for n in names)


BLOCKS: tuple[Block, ...] = (
    Block("comp", "Compresseur", 3, 9,
          family(("Advanced", "Sustaining", "Percussive"), COMP), enable_name="Comp"),
    Block("filter", "Filter", 13, 15,
          family(("Resonance Filter", "Touch Res Filter", "Auto Res Filter"), FILTER_RES)
          + family(("Wah wah", "Touch Wah", "Auto Wah"), FILTER_WAH)
          + family(("Formant", "Touch Formant", "Auto Formant"), FILTER_FORMANT)),
    Block("mod", "Mod", 29, 14,
          family(("Classic Chorus", "Advanced Chorus", "Classic Flanger", "Advanced Flanger", "Vibrato"), MOD_CHORUS)
          + family(("Vintage Phaser", "Smooth Phaser"), MOD_PHASER)
          + family(("Tremolo", "Panner"), MOD_TREMOLO)
          + family(("Vintage Univibe", "Modern Univibe"), MOD_UNIVIBE)),
    Block("pitch", "Pitch", 44, 19,
          family(("Pitch Shifter", "Octaver", "Whammy", "Detune"), PITCH_SHIFTER)
          + family(("Intelligent",), PITCH_INTELLIGENT) + family(("Doubler",), PITCH_DOUBLER)),
    Block("reverb", "Reverb", 64, 15, family(("Spring", "Hall", "Room", "Plate"), REVERB)),
    Block("gate", "Noise gate", 80, 5, params=GATE, enable_name="NG"),
    Block("delay", "Delay", 86, 27,
          family(("Single Delay", "Tape Delay", "Reverse", "Lo-Fi", "Ping Pong", "Dynamic Delay", "Dual Delay"),
                 DELAY)),
    Block("eq", "EQ", 114, 10, params=EQ, enable_name="EQ"),
)

# Blocks shown as round switches on the virtual front panel, in signal order.
SWITCH_BLOCKS = ("comp", "filter", "mod", "pitch", "delay", "reverb", "eq", "gate")
HEADER_FIELDS = (0, 1, 2)
CONFIDENCE = CONFIRMED


def block(key: str) -> Block:
    for b in BLOCKS:
        if b.key == key:
            return b
    raise KeyError(key)


def owner(index: int) -> Block | None:
    for b in BLOCKS:
        if index in b.all_fields():
            return b
    return None


def describe_field(data: bytes, index: int) -> tuple[str, str]:
    """(block label, parameter name) for a field of a given preset."""
    b = owner(index)
    if b is None:
        return ("Modifiers / routage" if index >= NUMERIC_FIELDS else "En-tête", "")
    if index == b.count_field:
        return (b.label, "(nombre de paramètres)")
    for f, p in b.fields(data):
        if f == index:
            return (b.label, p.name)
    return (b.label, "(inutilisé pour ce type)")


def unassigned_fields() -> list[int]:
    owned = {f for b in BLOCKS for f in b.all_fields()}
    return [i for i in range(FIELD_COUNT) if i not in owned]


def diff_fields(a: bytes, b: bytes) -> list[tuple[int, int, int]]:
    """Fields that differ between two presets: (index, value in a, value in b)."""
    return [(i, read_field(a, i), read_field(b, i)) for i in range(FIELD_COUNT)
            if a[field_offset(i) : field_offset(i) + 3] != b[field_offset(i) : field_offset(i) + 3]]
