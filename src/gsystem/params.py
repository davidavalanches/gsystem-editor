"""Preset parameter layout.

A preset's 516 data bytes are a 21-byte name followed by 165 fields of 3 bytes.
Fields 0-124 hold signed 24-bit little-endian values; fields 125-164 hold
byte-packed data (switch, pedal and modifier assignments) and are shown raw.

Which field holds which parameter was inferred from value statistics over the
user's banks and from the ranges published in the G-System manual. Every entry
says how sure we are: ``CONFIRMED`` entries were checked against independent
data, ``LIKELY`` entries match the manual's range exactly, ``GUESS`` entries
are placeholders to be verified on the hardware.
"""

from __future__ import annotations

from dataclasses import dataclass, field

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


@dataclass(frozen=True)
class Param:
    key: str
    label: str
    field: int
    lo: int
    hi: int
    unit: str = ""
    confidence: str = GUESS
    choices: tuple[str, ...] = ()

    @property
    def is_switch(self) -> bool:
        return self.choices == ("Off", "On")

    def format(self, value: int) -> str:
        if self.choices and 0 <= value - self.lo < len(self.choices):
            return self.choices[value - self.lo]
        return f"{value} {self.unit}".strip()


def onoff(key: str, label: str, index: int, confidence: str = GUESS) -> Param:
    return Param(key, label, index, 0, 1, "", confidence, ("Off", "On"))


@dataclass(frozen=True)
class Block:
    key: str
    label: str
    params: tuple[Param, ...]
    enable: Param | None = None
    # Fields believed to belong to this block but not yet identified.
    fields: tuple[int, ...] = field(default=())

    def all_fields(self) -> list[int]:
        known = {p.field for p in self.params} | ({self.enable.field} if self.enable else set())
        return sorted(known | set(self.fields))


BLOCKS: tuple[Block, ...] = (
    Block("levels", "Niveaux / routage", (
        Param("routing", "Routage", 4, 0, 2, confidence=GUESS, choices=("Série", "Semi-parallèle", "Parallèle")),
        Param("tempo", "Tempo", 16, 200, 2000, "ms", LIKELY),
    ), fields=tuple(range(0, 6))),
    Block("comp", "Compresseur", (
        Param("comp_threshold", "Seuil", 6, -40, 0, "dB", LIKELY),
        Param("comp_ratio", "Ratio", 7, 0, 15, confidence=GUESS),
        Param("comp_attack", "Attaque", 8, 0, 15, confidence=GUESS),
        Param("comp_release", "Relâchement", 9, 0, 25, confidence=GUESS),
        Param("comp_response", "Response", 12, 1, 10, confidence=GUESS),
    ), onoff("comp_on", "Compresseur", 15), fields=tuple(range(6, 16))),
    Block("filter", "Filter", (), onoff("filter_on", "Filter", 31), fields=tuple(range(17, 32))),
    Block("mod", "Mod", (), onoff("mod_on", "Mod", 46), fields=tuple(range(32, 47))),
    Block("pitch", "Pitch", (
        Param("pitch_v1", "Voix 1", 47, -1200, 1200, "cents", LIKELY),
        Param("pitch_v2", "Voix 2", 48, -1200, 1200, "cents", LIKELY),
        Param("pitch_pan1", "Pan voix 1", 49, -50, 50, confidence=GUESS),
        Param("pitch_pan2", "Pan voix 2", 50, -50, 50, confidence=GUESS),
        Param("pitch_dly1", "Délai voix 1", 51, 0, 350, "ms", LIKELY),
        Param("pitch_dly2", "Délai voix 2", 52, 0, 350, "ms", LIKELY),
        Param("pitch_mix", "Mix", 57, 0, 100, "%", GUESS),
    ), onoff("pitch_on", "Pitch", 59), fields=tuple(range(47, 61))),
    Block("gate", "Noise gate", (
        Param("gate_threshold", "Seuil", 83, -60, 0, "dB", LIKELY),
        Param("gate_damp", "Atténuation", 84, 0, 90, "dB", GUESS),
        Param("gate_speed", "Vitesse", 85, 3, 200, "dB/s", GUESS),
    ), onoff("gate_on", "Noise gate", 88), fields=tuple(range(83, 89))),
    Block("delay", "Delay", (
        Param("delay_time1", "Temps 1", 89, 0, 1800, "ms", LIKELY),
        Param("delay_time2", "Temps 2", 90, 0, 1800, "ms", LIKELY),
        Param("delay_fb1", "Feedback 1", 96, 0, 120, "%", GUESS),
        Param("delay_fb2", "Feedback 2", 97, 0, 120, "%", GUESS),
    ), None, fields=tuple(range(89, 102))),
    Block("reverb", "Reverb", (), None, fields=tuple(range(102, 114))),
    Block("eq", "EQ", (
        Param("eq_gain1", "Gain bas", 115, -12, 12, "dB", LIKELY),
        Param("eq_freq1", "Fréq. bas", 116, 0, 60, confidence=GUESS),
        Param("eq_width1", "Largeur bas", 117, 1, 40, "×0.1 oct", GUESS),
        Param("eq_gain2", "Gain médium", 118, -12, 12, "dB", LIKELY),
        Param("eq_freq2", "Fréq. médium", 119, 0, 60, confidence=GUESS),
        Param("eq_width2", "Largeur médium", 120, 1, 40, "×0.1 oct", GUESS),
        Param("eq_gain3", "Gain aigu", 121, -12, 12, "dB", LIKELY),
        Param("eq_freq3", "Fréq. aigu", 122, 0, 60, confidence=GUESS),
        Param("eq_width3", "Largeur aigu", 123, 1, 40, "×0.1 oct", GUESS),
    ), onoff("eq_on", "EQ", 124, LIKELY), fields=tuple(range(114, 125))),
    Block("modifiers", "Modifiers", (), None, fields=tuple(range(NUMERIC_FIELDS, FIELD_COUNT))),
)

# Blocks shown as round switches on the virtual front panel, in signal order.
SWITCH_BLOCKS = ("comp", "filter", "mod", "pitch", "delay", "reverb", "eq", "gate")


def block(key: str) -> Block:
    for b in BLOCKS:
        if b.key == key:
            return b
    raise KeyError(key)


def unassigned_fields() -> list[int]:
    owned = {f for b in BLOCKS for f in b.all_fields()}
    return [i for i in range(FIELD_COUNT) if i not in owned]


def diff_fields(a: bytes, b: bytes) -> list[tuple[int, int, int]]:
    """Fields that differ between two presets: (index, value in a, value in b)."""
    return [(i, read_field(a, i), read_field(b, i)) for i in range(FIELD_COUNT)
            if a[field_offset(i) : field_offset(i) + 3] != b[field_offset(i) : field_offset(i) + 3]]
