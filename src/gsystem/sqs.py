"""Read and write Vyzor/Midi Quest ``.SQS`` bank files.

An ``.SQS`` file is a big-endian IFF container (``LIST`` of ``FORM BANK``). Each
bank has a ``SHDR`` header naming the instrument and the bank kind ("Preset
buffer", "User Bank", "Global", ...) and a ``BODY`` holding fixed-size slots,
each one either zero-filled (empty) or a SysEx dump followed by zero padding.

Only the ``BODY`` slots are rewritten; every other byte of the file is kept as
is, so files stay readable by Vyzor.
"""

from __future__ import annotations

import os
import shutil
import struct
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .sysex import SYSEX_START, USER_SLOTS, Preset, SysexError, is_preset_dump, split_sysex, user_number

USER_BANK_KIND = "User Bank"
PRESET_BUFFER_KIND = "Preset buffer"


class SqsError(ValueError):
    pass


@dataclass
class Bank:
    instrument: str
    kind: str
    body_offset: int
    body_size: int
    slot_count: int

    @property
    def slot_size(self) -> int:
        return self.body_size // self.slot_count


def _cstr(raw: bytes) -> str:
    return raw.split(b"\0")[0].decode("latin-1")


def _read_chunks(data: bytes, start: int) -> dict[bytes, tuple[int, int]]:
    """Read sub-chunks up to the next FORM. Vyzor writes FORM sizes that are too
    small, so the declared size cannot be used to bound a bank."""
    chunks = {}
    off = start
    while off + 8 <= len(data):
        cid = data[off : off + 4]
        if cid in (b"FORM", b"LIST") or not all(0x20 <= c < 0x7F for c in cid):
            break
        size = struct.unpack(">I", data[off + 4 : off + 8])[0]
        if off + 8 + size > len(data):
            raise SqsError(f"chunk {cid!r} at {off} overruns the file")
        chunks.setdefault(cid, (off + 8, size))
        off += 8 + size + (size & 1)
    return chunks


class SqsFile:
    def __init__(self, data: bytes, path: Path | None = None) -> None:
        self._data = bytearray(data)
        self.path = path
        self.banks = self._find_banks()

    @classmethod
    def load(cls, path: str | os.PathLike) -> SqsFile:
        path = Path(path)
        return cls(path.read_bytes(), path)

    def _find_banks(self) -> list[Bank]:
        data = bytes(self._data)
        if data[:4] != b"LIST":
            raise SqsError("not an SQS file (missing LIST header)")
        banks = []
        pos = data.find(b"FORM")
        while pos != -1:
            if data[pos + 8 : pos + 12] == b"BANK":
                chunks = _read_chunks(data, pos + 12)
                if b"SHDR" in chunks and b"BODY" in chunks:
                    shdr_off, _ = chunks[b"SHDR"]
                    body_off, body_size = chunks[b"BODY"]
                    kind = _cstr(data[shdr_off + 16 : shdr_off + 32])
                    # The header reuses a stale buffer: "Preset\0ffer" means "Preset buffer".
                    if kind == "Preset":
                        kind = PRESET_BUFFER_KIND
                    slots = USER_SLOTS if kind == USER_BANK_KIND else 1
                    if body_size % slots:
                        raise SqsError(f"bank {kind!r}: body size {body_size} not divisible by {slots}")
                    banks.append(Bank(_cstr(data[shdr_off : shdr_off + 16]), kind, body_off, body_size, slots))
            pos += 4
            pos = data.find(b"FORM", pos)
        return banks

    def bank(self, kind: str, instrument: str = "TCE G-System") -> Bank:
        for bank in self.banks:
            if bank.kind == kind and bank.instrument == instrument:
                return bank
        raise SqsError(f"no {kind!r} bank for {instrument!r}")

    def _slot_range(self, bank: Bank, slot: int) -> tuple[int, int]:
        if not 0 <= slot < bank.slot_count:
            raise SqsError(f"slot {slot} out of range")
        start = bank.body_offset + slot * bank.slot_size
        return start, start + bank.slot_size

    def read_slot(self, bank: Bank, slot: int) -> bytes | None:
        """Return the raw SysEx message stored in a slot, or None if it is empty."""
        start, end = self._slot_range(bank, slot)
        raw = bytes(self._data[start:end])
        if raw[0] != SYSEX_START:
            return None
        stop = raw.find(0xF7)
        # Vyzor initialises some slots with a bare header and no data.
        return raw[: stop + 1] if stop != -1 else None

    def user_presets(self) -> list[Preset | None]:
        """All 200 user slots; checksum mismatches are kept and flagged, not rejected."""
        bank = self.bank(USER_BANK_KIND)
        presets: list[Preset | None] = []
        for slot in range(bank.slot_count):
            msg = self.read_slot(bank, slot)
            presets.append(Preset.from_sysex(msg, strict=False) if msg and is_preset_dump(msg) else None)
        return presets

    def set_user_preset(self, slot: int, preset: Preset | None) -> None:
        bank = self.bank(USER_BANK_KIND)
        start, end = self._slot_range(bank, slot)
        content = b"" if preset is None else preset.to_sysex(number=user_number(slot))
        if len(content) > end - start:
            raise SysexError("dump does not fit in slot")
        self._data[start:end] = content.ljust(end - start, b"\0")

    def to_bytes(self) -> bytes:
        return bytes(self._data)

    def save(self, path: str | os.PathLike | None = None, backup: bool = True) -> Path:
        """Write atomically. An existing target is first copied to a timestamped .bak."""
        target = Path(path) if path is not None else self.path
        if target is None:
            raise SqsError("no destination path")
        return atomic_write(target, self.to_bytes(), backup)


def atomic_write(target: Path, content: bytes, backup: bool = True) -> Path:
    target = Path(target)
    if backup and target.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(target, target.with_name(f"{target.name}.{stamp}.bak"))
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(content)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, target)
    except BaseException:
        os.unlink(tmp)
        raise
    return target


def write_syx(path: str | os.PathLike, presets: list[Preset], backup: bool = True) -> Path:
    return atomic_write(Path(path), b"".join(p.to_sysex() for p in presets), backup)


def read_syx(path: str | os.PathLike) -> list[Preset]:
    return [Preset.from_sysex(m, strict=False) for m in split_sysex(Path(path).read_bytes()) if is_preset_dump(m)]

