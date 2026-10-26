"""TC Electronic G-System SysEx preset dumps.

Layout of a preset dump (1044 bytes), as observed in dumps produced by the unit:

    F0 00 20 1F <dev> 55 20 01 <num_hi> <num_lo> <1032 nibbles> <checksum> F7

- ``00 20 1F`` is TC Electronic's manufacturer ID, ``55`` the G-System model ID.
- The preset number is a 14-bit value; user presets start at 100 (slot 0 = 100).
- Each payload byte is sent as two nibbles, high nibble first (516 bytes).
- The checksum is the sum of all nibbles, masked to 7 bits.
- The name is the first 20 payload bytes. Bit 7 of some name bytes is set by the
  unit; its meaning is unknown, so it is displayed masked and always preserved.
"""

from __future__ import annotations

from dataclasses import dataclass

SYSEX_START = 0xF0
SYSEX_END = 0xF7
TC_MANUFACTURER = bytes((0x00, 0x20, 0x1F))
MODEL_G_SYSTEM = 0x55
MSG_PRESET = bytes((0x20, 0x01))
DEVICE_ID_ALL = 0x7F

HEADER_LEN = 10
PRESET_DATA_LEN = 516
PRESET_DUMP_LEN = HEADER_LEN + 2 * PRESET_DATA_LEN + 2
NAME_LEN = 20

USER_PRESET_BASE = 100
USER_SLOTS = 200


class SysexError(ValueError):
    pass


class ChecksumError(SysexError):
    pass


def nibbles_to_bytes(nibbles: bytes) -> bytes:
    if len(nibbles) % 2:
        raise SysexError("odd nibble count")
    if any(n > 0x0F for n in nibbles):
        raise SysexError("nibble value above 0x0F")
    return bytes((nibbles[i] << 4) | nibbles[i + 1] for i in range(0, len(nibbles), 2))


def bytes_to_nibbles(data: bytes) -> bytes:
    out = bytearray()
    for b in data:
        out += bytes((b >> 4, b & 0x0F))
    return bytes(out)


def checksum(nibbles: bytes) -> int:
    return sum(nibbles) & 0x7F


def split_sysex(stream: bytes) -> list[bytes]:
    """Split a raw byte stream (e.g. a .syx file) into complete SysEx messages."""
    messages = []
    start = None
    for i, b in enumerate(stream):
        if b == SYSEX_START:
            start = i
        elif b == SYSEX_END and start is not None:
            messages.append(bytes(stream[start : i + 1]))
            start = None
    return messages


def is_preset_dump(msg: bytes) -> bool:
    return (
        len(msg) == PRESET_DUMP_LEN
        and msg[0] == SYSEX_START
        and msg[1:4] == TC_MANUFACTURER
        and msg[5] == MODEL_G_SYSTEM
        and msg[6:8] == MSG_PRESET
        and msg[-1] == SYSEX_END
    )


@dataclass
class Preset:
    number: int
    data: bytes
    device_id: int = DEVICE_ID_ALL
    # Checksum found in the source dump; None when the preset was built in memory.
    source_checksum: int | None = None

    def __post_init__(self) -> None:
        if len(self.data) != PRESET_DATA_LEN:
            raise SysexError(f"preset data must be {PRESET_DATA_LEN} bytes, got {len(self.data)}")
        if not 0 <= self.number < 1 << 14:
            raise SysexError(f"preset number out of range: {self.number}")

    @classmethod
    def from_sysex(cls, msg: bytes, strict: bool = True) -> Preset:
        """Parse a preset dump. With strict=False a checksum mismatch is kept, not raised."""
        if not is_preset_dump(msg):
            raise SysexError("not a G-System preset dump")
        nibbles = msg[HEADER_LEN:-2]
        stored = msg[-2]
        if strict and checksum(nibbles) != stored:
            raise ChecksumError(f"checksum mismatch: stored {stored}, computed {checksum(nibbles)}")
        return cls(
            number=(msg[8] << 7) | msg[9],
            data=nibbles_to_bytes(nibbles),
            device_id=msg[4],
            source_checksum=stored,
        )

    def to_sysex(self, number: int | None = None, device_id: int | None = None) -> bytes:
        """Build a dump; the checksum is always recomputed from the data."""
        num = self.number if number is None else number
        dev = self.device_id if device_id is None else device_id
        nibbles = bytes_to_nibbles(self.data)
        header = bytes((SYSEX_START, *TC_MANUFACTURER, dev, MODEL_G_SYSTEM, *MSG_PRESET, num >> 7, num & 0x7F))
        return header + nibbles + bytes((checksum(nibbles), SYSEX_END))

    @property
    def checksum_ok(self) -> bool:
        return self.source_checksum is None or self.source_checksum == checksum(bytes_to_nibbles(self.data))

    @property
    def name(self) -> str:
        chars = (b & 0x7F for b in self.data[:NAME_LEN])
        return "".join(chr(c) if 0x20 <= c < 0x7F else " " for c in chars).rstrip()

    def with_name(self, name: str) -> Preset:
        encoded = name.encode("ascii", "replace")[:NAME_LEN].ljust(NAME_LEN, b" ")
        if any(c < 0x20 or c > 0x7E for c in encoded):
            raise SysexError("name must be printable ASCII")
        # Keep the unit's bit 7 flags on each name byte.
        new_name = bytes((old & 0x80) | new for old, new in zip(self.data[:NAME_LEN], encoded))
        return Preset(self.number, new_name + self.data[NAME_LEN:], self.device_id)

    def with_number(self, number: int) -> Preset:
        return Preset(number, self.data, self.device_id)

    @property
    def user_slot(self) -> int | None:
        slot = self.number - USER_PRESET_BASE
        return slot if 0 <= slot < USER_SLOTS else None


def user_number(slot: int) -> int:
    if not 0 <= slot < USER_SLOTS:
        raise SysexError(f"user slot out of range: {slot}")
    return USER_PRESET_BASE + slot
