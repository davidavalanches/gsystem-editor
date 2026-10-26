import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
QtWidgets = pytest.importorskip("PySide6.QtWidgets")

from gsystem.editor import PresetEditor  # noqa: E402
from gsystem.model import BankModel, Library  # noqa: E402
from gsystem.params import block, read_field  # noqa: E402
from gsystem.sysex import PRESET_DATA_LEN, Preset  # noqa: E402


@pytest.fixture(scope="module")
def app():
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


@pytest.fixture
def editor(app):
    presets = [Preset(100 + i, b"Preset".ljust(21, b" ") + bytes(PRESET_DATA_LEN - 21)) for i in range(3)]
    model = BankModel(Library(presets))
    ed = PresetEditor(model)
    ed.store_requested.connect(lambda slot, p: model.set_slots({slot: p}, "store"))
    return ed, model


def test_switch_edits_buffer_not_bank(editor):
    ed, model = editor
    eq_on = block("eq").enable_field(ed.buffer.data)
    ed.press("eq")
    assert read_field(ed.buffer.data, eq_on) == 1 and ed.is_dirty()
    assert read_field(model.preset(0).data, eq_on) == 0


def test_undo_and_store(editor):
    ed, model = editor
    ed.set_field(47, 700, "pitch")
    ed.undo_stack.undo()
    assert read_field(ed.buffer.data, 47) == 0 and not ed.is_dirty()
    ed.undo_stack.redo()
    ed.store()
    assert read_field(model.preset(0).data, 47) == 700 and not ed.is_dirty()
    model.undo_stack.undo()
    assert read_field(model.preset(0).data, 47) == 0


def test_empty_slot_disables_editing(editor):
    ed, model = editor
    model.set_slots({2: None}, "clear")
    ed.open_slot(2)
    assert ed.buffer is None and "eq" not in ed.panel.enabled_keys


def test_live_mode_sends_and_mirrors(editor):
    ed, _model = editor
    sent = []
    ed.block_ids = {"delay": 9}
    ed.send_param = lambda *a: sent.append(a)
    ed.live.setEnabled(True)
    ed.live.setChecked(True)
    delay = block("delay")
    ed.set_field(delay.first_field + 1, 1, "delay on")
    assert sent == [(9, 1, 1)]
    ed.undo_stack.undo()
    assert sent[-1] == (9, 1, 0)
    sent.clear()
    ed.apply_from_unit(9, 1, 1)  # switch pressed on the unit
    assert read_field(ed.buffer.data, delay.first_field + 1) == 1 and sent == []
    ed.apply_from_unit(42, 1, 1)  # unknown block: ignored
    assert sent == []


def test_level_switches_need_live_mode(editor):
    ed, _model = editor
    sent = []
    ed.send_param = lambda *a: sent.append(a)
    ed.press("loop2")
    assert sent == [] and "loop2" not in ed.panel.enabled_keys
    ed.live.setEnabled(True)
    ed.live.setChecked(True)
    ed.press("loop2")
    assert sent == [(1, 20, 1)] and ed.level_states["loop2"] is True
    ed.apply_from_unit(1, 20, 0)  # Loop 2 pressed on the unit
    assert ed.level_states["loop2"] is False


def test_bank_navigation(editor):
    ed, _model = editor
    ed.press("preset3")
    assert ed.slot == 2


def test_up_down_change_bank_and_keep_position(app):
    presets = [Preset(100 + i, b"P".ljust(21, b" ") + bytes(PRESET_DATA_LEN - 21)) for i in range(200)]
    ed = PresetEditor(BankModel(Library(presets)))
    ed.press("preset2")
    assert ed.slot == 1
    ed.press("up")
    assert ed.slot == 6  # bank 01, preset 2
    ed.press("down")
    ed.press("down")
    assert ed.slot == 196  # wraps to bank 39, preset 2


def test_slot_labels():
    from gsystem.model import slot_label
    assert slot_label(0) == "00-1" and slot_label(6) == "01-2" and slot_label(199) == "39-5"
