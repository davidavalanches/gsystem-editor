import pytest

from gsystem.params import (
    BLOCKS,
    FIELD_COUNT,
    block,
    diff_fields,
    field_offset,
    freq,
    read_field,
    write_field,
)
from gsystem.sysex import PRESET_DATA_LEN

BLANK = bytes(PRESET_DATA_LEN)


def test_layout_covers_payload_exactly():
    assert FIELD_COUNT == 165
    assert field_offset(FIELD_COUNT - 1) + 3 == PRESET_DATA_LEN


@pytest.mark.parametrize("value", [0, 1, -1, -25, 1800, -1200, (1 << 23) - 1, -(1 << 23)])
def test_field_round_trip(value):
    data = write_field(BLANK, 47, value)
    assert read_field(data, 47) == value
    assert len(data) == PRESET_DATA_LEN


def test_write_rejects_overflow():
    with pytest.raises(ValueError):
        write_field(BLANK, 0, 1 << 23)


def test_diff_fields():
    changed = write_field(write_field(BLANK, 3, 9), 100, -2)
    assert diff_fields(BLANK, changed) == [(3, 0, 9), (100, 0, -2)]


def test_blocks_are_contiguous_and_do_not_overlap():
    expected = 3
    for b in BLOCKS:
        assert b.count_field == expected, b.key
        expected = b.first_field + b.size
    assert expected == 125


@pytest.mark.parametrize("b", BLOCKS, ids=lambda b: b.key)
def test_every_type_fits_its_slot(b):
    for t in b.types or (None,):
        data = write_field(BLANK, b.first_field, b.types.index(t)) if t else BLANK
        assert len(b.param_list(data)) <= b.size


def test_eq_snippet_decodes():
    # "EQ orange" snippet saved by Vyzor (count + 10 parameters), at field 114.
    snippet = bytes([10, 0, 0, 253, 255, 255, 12, 0, 0, 10, 0, 0, 2, 0, 0, 31, 0, 0,
                     18, 0, 0, 251, 255, 255, 48, 0, 0, 26, 0, 0, 1, 0, 0])
    data = BLANK[:field_offset(114)] + snippet + BLANK[field_offset(125):]
    eq = block("eq")
    values = {p.name: read_field(data, f) for f, p in eq.fields(data)}
    assert values["Gain1"] == -3 and values["EQ"] == 1
    assert eq.enable_field(data) == 124


def test_type_selects_parameter_set():
    filt = block("filter")
    wah = write_field(BLANK, filt.first_field, 5)       # Auto Wah
    formant = write_field(BLANK, filt.first_field, 8)   # Auto Formant
    assert filt.effect_type(wah).name == "Auto Wah"
    assert [p.name for _, p in filt.fields(wah)][-1] == "AutoOn"
    assert "Bright" in [p.name for _, p in filt.fields(formant)]
    assert filt.enable_field(wah) == filt.first_field + 1


def test_frequency_display_matches_manual():
    assert freq(34) == "1.02 kHz" and freq(54) == "10.24 kHz" and freq(18) == "160 Hz"
