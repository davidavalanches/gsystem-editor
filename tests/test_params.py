import pytest

from gsystem.params import (
    BLOCKS,
    FIELD_COUNT,
    diff_fields,
    field_offset,
    read_field,
    unassigned_fields,
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


def test_eq_snippet_decodes_as_signed_fields():
    # "EQ orange" snippet saved by Vyzor in Preset.ini, found at field 114.
    snippet = bytes([10, 0, 0, 253, 255, 255, 12, 0, 0, 10, 0, 0, 2, 0, 0, 31, 0, 0,
                     18, 0, 0, 251, 255, 255, 48, 0, 0, 26, 0, 0, 1, 0, 0])
    data = BLANK[:field_offset(114)] + snippet + BLANK[field_offset(125):]
    assert [read_field(data, i) for i in range(114, 125)] == [10, -3, 12, 10, 2, 31, 18, -5, 48, 26, 1]


def test_write_rejects_overflow():
    with pytest.raises(ValueError):
        write_field(BLANK, 0, 1 << 23)


def test_diff_fields():
    changed = write_field(write_field(BLANK, 3, 9), 100, -2)
    assert diff_fields(BLANK, changed) == [(3, 0, 9), (100, 0, -2)]


def test_params_reference_valid_unique_fields():
    seen = set()
    for b in BLOCKS:
        params = list(b.params) + ([b.enable] if b.enable else [])
        for p in params:
            assert 0 <= p.field < FIELD_COUNT and p.lo <= p.hi
            assert p.field not in seen, p.key
            seen.add(p.field)


def test_every_field_belongs_somewhere_or_is_reported():
    assert all(0 <= i < FIELD_COUNT for i in unassigned_fields())
