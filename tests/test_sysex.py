import pytest

from gsystem.sysex import (
    PRESET_DATA_LEN,
    PRESET_DUMP_LEN,
    ChecksumError,
    Preset,
    SysexError,
    bytes_to_nibbles,
    nibbles_to_bytes,
    split_sysex,
    user_number,
)


def make_preset(name: bytes = b"Test", number: int = 100) -> Preset:
    data = name.ljust(20, b" ") + bytes(range(256)) + bytes(PRESET_DATA_LEN - 276)
    return Preset(number, data)


def test_nibble_round_trip():
    raw = bytes(range(256))
    assert nibbles_to_bytes(bytes_to_nibbles(raw)) == raw


def test_nibble_rejects_7bit_overflow():
    with pytest.raises(SysexError):
        nibbles_to_bytes(bytes((0x10, 0x00)))


def test_dump_round_trip():
    preset = make_preset(number=237)
    msg = preset.to_sysex()
    assert len(msg) == PRESET_DUMP_LEN
    assert msg[:8] == bytes.fromhex("F000201F7F552001")
    assert all(b < 0x80 for b in msg[1:-1])
    parsed = Preset.from_sysex(msg)
    assert parsed.number == 237 and parsed.data == preset.data and parsed.checksum_ok


def test_checksum_mismatch_strict_and_lenient():
    msg = bytearray(make_preset().to_sysex())
    msg[-2] = (msg[-2] + 1) & 0x7F
    with pytest.raises(ChecksumError):
        Preset.from_sysex(bytes(msg))
    lenient = Preset.from_sysex(bytes(msg), strict=False)
    assert not lenient.checksum_ok
    # Re-encoding repairs the checksum.
    assert Preset.from_sysex(lenient.to_sysex()).checksum_ok


def test_name_masks_and_preserves_bit7():
    data = bytearray(make_preset(b"Eau trouble").data)
    data[5] |= 0x80  # 'r' with the unit's flag bit
    data[19] |= 0x80
    preset = Preset(100, bytes(data))
    assert preset.name == "Eau trouble"
    renamed = preset.with_name("Clean")
    assert renamed.name == "Clean"
    assert renamed.data[5] & 0x80 and renamed.data[19] & 0x80
    assert renamed.data[20:] == preset.data[20:]


def test_split_sysex_ignores_garbage():
    a, b = make_preset().to_sysex(), make_preset(number=101).to_sysex()
    assert split_sysex(b"\x00\x01" + a + b"\xf7junk" + b) == [a, b]


def test_user_numbering():
    assert user_number(0) == 100 and user_number(199) == 299
    with pytest.raises(SysexError):
        user_number(200)


def test_name_hides_control_characters():
    data = bytearray(make_preset(b"Rituel - intro").data)
    data[18] = 0x9C  # control character once bit 7 is masked
    assert Preset(100, bytes(data)).name == "Rituel - intro"
