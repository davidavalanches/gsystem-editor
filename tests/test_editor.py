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
    ed.switches["eq"].click()
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
    assert ed.buffer is None and not ed.switches["eq"].isEnabled()


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
