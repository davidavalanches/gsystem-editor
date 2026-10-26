"""Tests against real Vyzor bank files.

They are not shipped with the repository; point GSYSTEM_SAMPLES at a folder of
.SQS files (default: the Vyzor documents folder) or these tests are skipped.
"""

import os
from pathlib import Path

import pytest

from gsystem.sqs import USER_BANK_KIND, SqsFile, read_syx, write_syx
from gsystem.sysex import Preset

SAMPLES = Path(os.environ.get("GSYSTEM_SAMPLES", Path.home() / "Documents/Psicraft/Vyzor G-System"))
FILES = sorted(p for p in SAMPLES.rglob("*") if p.suffix.lower() == ".sqs") if SAMPLES.is_dir() else []

pytestmark = pytest.mark.skipif(not FILES, reason="no sample .SQS files")


@pytest.fixture(params=FILES, ids=lambda p: p.name)
def sqs(request):
    return SqsFile.load(request.param)


def test_user_bank_present(sqs):
    bank = sqs.bank(USER_BANK_KIND)
    assert bank.slot_count == 200 and bank.slot_size == 1310


def test_most_slot_numbers_match_position(sqs):
    # Vyzor keeps the number a preset was dumped with, even after moving it,
    # so a few slots legitimately disagree with their position.
    presets = [(slot, p) for slot, p in enumerate(sqs.user_presets()) if p is not None]
    matching = sum(1 for slot, p in presets if p.user_slot == slot)
    assert matching >= len(presets) * 0.8


def test_rewriting_all_valid_presets_is_byte_identical(sqs):
    original = sqs.to_bytes()
    for slot, preset in enumerate(sqs.user_presets()):
        if preset is not None and preset.checksum_ok and preset.user_slot == slot:
            sqs.set_user_preset(slot, preset)
    assert sqs.to_bytes() == original


def test_save_keeps_backup(tmp_path, sqs):
    target = tmp_path / "bank.sqs"
    target.write_bytes(b"old")
    sqs.save(target)
    assert target.read_bytes() == sqs.to_bytes()
    assert [p.read_bytes() for p in tmp_path.glob("bank.sqs.*.bak")] == [b"old"]


def test_syx_round_trip(tmp_path, sqs):
    presets = [p for p in sqs.user_presets() if p is not None]
    write_syx(tmp_path / "out.syx", presets)
    back = read_syx(tmp_path / "out.syx")
    assert [(p.number, p.data) for p in back] == [(p.number, p.data) for p in presets]
    assert all(isinstance(p, Preset) and p.checksum_ok for p in back)
