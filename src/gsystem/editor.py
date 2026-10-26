"""Preset editor: virtual front panel, block switches and parameter views."""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont, QUndoCommand, QUndoStack
from PySide6.QtWidgets import (
    QButtonGroup,
    QComboBox,
    QDial,
    QGridLayout,
    QGroupBox,
    QInputDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QStackedWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .params import (
    BLOCKS,
    FIELD_COUNT,
    HEADER_FIELDS,
    NUMERIC_FIELDS,
    SWITCH_BLOCKS,
    Block,
    Param,
    block,
    describe_field,
    diff_fields,
    owner,
    field_offset,
    read_field,
    write_field,
)
from .frontpanel import FrontPanel
from .model import BANK_COUNT, PRESETS_PER_BANK, bank_position
from .sysex import NAME_LEN, USER_SLOTS, Preset, SysexError

# The "Levels" table of the firmware (block 1 in parameter messages): switch indices.
LEVELS_BLOCK_ID = 1
LEVEL_SWITCHES = {"loop1": 19, "loop2": 20, "loop3": 21, "loop4": 22, "insert": 23, "boost": 10}

FIELD_MIN, FIELD_MAX = -(1 << 23), (1 << 23) - 1

# Preset sub-views, as in the hardware's effect sections.
VIEWS = (
    ("all", "Tout", None),
    ("filter", "Filter", ("filter",)),
    ("dyn", "Dyn | EQ", ("comp", "gate", "eq")),
    ("mod", "Mod", ("mod",)),
    ("pitch", "Pitch", ("pitch",)),
    ("delay", "Delay", ("delay",)),
    ("reverb", "Reverb", ("reverb",)),
    ("modifiers", "Modifiers", ()),
)


class ParamControl(QWidget):
    """Dial or value list bound to one preset field."""

    edited = Signal(int, int)  # field, value

    def __init__(self, index: int, param: Param, parent=None) -> None:
        super().__init__(parent)
        self.index = index
        self.param = param
        title = QLabel(param.name)
        title.setAlignment(Qt.AlignCenter)
        title.setToolTip(f"Champ #{index} — plage {param.lo} à {param.hi}")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)
        layout.addWidget(title)
        self.combo = self.dial = None
        self.readout = QLabel()
        self.readout.setAlignment(Qt.AlignCenter)
        if param.choices:
            self.combo = QComboBox()
            for value in range(param.lo, param.hi + 1):
                self.combo.addItem(param.format(value), value)
            self.combo.currentIndexChanged.connect(lambda i: self.edited.emit(index, self.combo.itemData(i)))
            layout.addWidget(self.combo)
        else:
            self.dial = QDial()
            self.dial.setNotchesVisible(True)
            self.dial.setRange(param.lo, param.hi)
            em = self.fontMetrics().height()
            self.dial.setMinimumSize(int(em * 3.5), int(em * 3.5))
            self.dial.valueChanged.connect(self._dial_moved)
            self.dial.sliderReleased.connect(lambda: self.edited.emit(index, self.dial.value()))
            layout.addWidget(self.dial, 1, Qt.AlignCenter)
            layout.addWidget(self.readout)

    def _dial_moved(self, value: int) -> None:
        self.readout.setText(self.param.format(value))
        if not self.dial.isSliderDown():
            self.edited.emit(self.index, value)

    def set_value(self, value: int) -> None:
        if self.combo is not None:
            self.combo.blockSignals(True)
            i = self.combo.findData(value)
            if i < 0:
                self.combo.addItem(f"? {value}", value)
                i = self.combo.count() - 1
            self.combo.setCurrentIndex(i)
            self.combo.blockSignals(False)
        else:
            self.dial.blockSignals(True)
            self.dial.setValue(value)
            self.dial.blockSignals(False)
            out_of_range = not self.param.lo <= value <= self.param.hi
            self.readout.setText(self.param.format(value) + ("  ⚠ hors plage" if out_of_range else ""))


class RawFieldEditor(QWidget):
    """Plain spinbox for a field whose meaning is not decoded yet."""

    edited = Signal(int, int)

    def __init__(self, index: int, parent=None) -> None:
        super().__init__(parent)
        self.index = index
        layout = QHBoxLayout(self)
        layout.setContentsMargins(2, 2, 2, 2)
        label = QLabel(f"#{index}")
        label.setToolTip(f"Champ #{index}, octet {field_offset(index)}")
        self.spin = QSpinBox()
        self.spin.setRange(FIELD_MIN, FIELD_MAX)
        self.spin.editingFinished.connect(lambda: self.edited.emit(index, self.spin.value()))
        layout.addWidget(label)
        layout.addWidget(self.spin, 1)

    def load(self, data: bytes) -> None:
        self.spin.blockSignals(True)
        self.spin.setValue(read_field(data, self.index))
        self.spin.blockSignals(False)


class BlockPanel(QGroupBox):
    """Controls of one effect block, rebuilt when the effect type changes."""

    edited = Signal(int, int)

    def __init__(self, blk: Block, columns: int = 6, parent=None) -> None:
        super().__init__(blk.label, parent)
        self.blk = blk
        self.columns = columns
        self.signature: tuple | None = None
        self.controls: list[ParamControl] = []
        self.grid = QGridLayout(self)

    def load(self, data: bytes) -> None:
        fields = self.blk.fields(data)
        signature = tuple((f, p.name) for f, p in fields)
        if signature != self.signature:
            self._rebuild(fields)
            self.signature = signature
        for ctrl in self.controls:
            ctrl.set_value(read_field(data, ctrl.index))

    def _rebuild(self, fields) -> None:
        for ctrl in self.controls:
            self.grid.removeWidget(ctrl)
            ctrl.deleteLater()
        self.controls = []
        for i, (index, param) in enumerate(fields):
            ctrl = ParamControl(index, param)
            ctrl.setFont(self.font())
            ctrl.edited.connect(self.edited)
            self.controls.append(ctrl)
            self.grid.addWidget(ctrl, i // self.columns, i % self.columns)


class RawPanel(QGroupBox):
    """Fields not decoded yet (routing, levels, modifiers), editable as numbers."""

    edited = Signal(int, int)

    def __init__(self, title: str, fields, parent=None) -> None:
        super().__init__(title, parent)
        grid = QGridLayout(self)
        self.editors = []
        for i, index in enumerate(fields):
            raw = RawFieldEditor(index)
            raw.edited.connect(self.edited)
            self.editors.append(raw)
            grid.addWidget(raw, i // 4, i % 4)

    def load(self, data: bytes) -> None:
        for raw in self.editors:
            raw.load(data)


class RawTable(QTableWidget):
    """All 165 fields with their meaning for the current preset, editable."""

    edited = Signal(int, int)

    def __init__(self, parent=None) -> None:
        super().__init__(FIELD_COUNT, 6, parent)
        self.setHorizontalHeaderLabels(("Champ", "Octet", "Valeur", "Affichage", "Bloc", "Paramètre"))
        self.verticalHeader().hide()
        self.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self.horizontalHeader().setSectionResizeMode(5, QHeaderView.Stretch)
        for i in range(FIELD_COUNT):
            for col in range(6):
                item = QTableWidgetItem(str(i) if col == 0 else str(field_offset(i)) if col == 1 else "")
                if col != 2:
                    item.setFlags(item.flags() & ~Qt.ItemIsEditable)
                self.setItem(i, col, item)
        self._loading = False
        self.itemChanged.connect(self._changed)

    def load(self, data: bytes) -> None:
        self._loading = True
        shown = {}
        for blk in BLOCKS:
            for f, p in blk.fields(data):
                shown[f] = p
        for i in range(FIELD_COUNT):
            value = read_field(data, i)
            raw = data[field_offset(i) : field_offset(i) + 3].hex(" ").upper()
            self.item(i, 2).setText(str(value) if i < NUMERIC_FIELDS else f"{value}  [{raw}]")
            self.item(i, 3).setText(shown[i].format(value) if i in shown else "")
            blk_label, name = describe_field(data, i)
            self.item(i, 4).setText(blk_label)
            self.item(i, 5).setText(name)
        self._loading = False

    def _changed(self, item: QTableWidgetItem) -> None:
        if self._loading or item.column() != 2:
            return
        try:
            value = int(item.text().split()[0])
        except (ValueError, IndexError):
            return
        self.edited.emit(item.row(), value)


class CurrentPageStack(QStackedWidget):
    """Stacked widget that takes the height of the visible page only."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.currentChanged.connect(lambda _i: self.updateGeometry())

    def sizeHint(self):
        page = self.currentWidget()
        return page.sizeHint() if page else super().sizeHint()

    def minimumSizeHint(self):
        page = self.currentWidget()
        return page.minimumSizeHint() if page else super().minimumSizeHint()


DEV_VIEWS = ("modifiers", "raw", "compare")


class SetBufferCommand(QUndoCommand):
    def __init__(self, editor: PresetEditor, before: Preset, after: Preset, text: str) -> None:
        super().__init__(text)
        self.editor, self.before, self.after = editor, before, after

    def redo(self) -> None:
        self.editor._set_buffer(self.after)

    def undo(self) -> None:
        self.editor._set_buffer(self.before)


class PresetEditor(QWidget):
    """Edit buffer for one preset. Changes reach the bank only through Store."""

    store_requested = Signal(int, object)  # slot, Preset
    notice = Signal(str)  # short message for the status bar
    buffer_changed = Signal(object)  # Preset, for live audition once MIDI send is validated

    def __init__(self, bank_model, parent=None) -> None:
        super().__init__(parent)
        self.bank = bank_model
        self.undo_stack = QUndoStack(self)
        self.slot = 0
        self.buffer: Preset | None = None
        self.stored: Preset | None = None
        # Live link: block key -> G-System block id, and a callable(block_id, param, value).
        self.block_ids: dict[str, int] = {}
        self.send_param = None
        self._from_unit = False

        # Level switches (loops, insert, boost) are live-only: their place in the
        # preset data is not decoded yet, so their state is unknown until seen.
        self.level_states: dict[str, bool | None] = {k: None for k in LEVEL_SWITCHES}

        self.panel = FrontPanel()
        self.panel.pressed.connect(self.press)
        self.panel.name_clicked.connect(self.rename_dialog)

        store = QPushButton("Store")
        store.setToolTip("Enregistrer le preset modifié dans son emplacement de la banque")
        store.clicked.connect(self.store)
        revert = QPushButton("Revenir")
        revert.setToolTip("Abandonner les modifications non stockées")
        revert.clicked.connect(self.revert)
        self.live = QPushButton("Live", checkable=True)
        self.live.setEnabled(False)
        self.live.setToolTip("Envoyer chaque modification au G-System (mémoire de travail, sans Store) "
                             "et suivre les changements faits sur le pédalier")
        self.live.toggled.connect(self._live_toggled)

        header = QHBoxLayout()
        header.addStretch(1)
        header.addWidget(self.live)
        header.addWidget(store)
        header.addWidget(revert)

        # View selector and pages.
        self.view_buttons = QButtonGroup(self)
        view_row = QHBoxLayout()
        self.pages = CurrentPageStack()
        self.panels: list = []
        self.dev_buttons = []
        for i, (key, label, blocks) in enumerate(VIEWS + (("raw", "Brut", None), ("compare", "Comparer", None))):
            btn = QPushButton(label, checkable=True)
            self.view_buttons.addButton(btn, i)
            view_row.addWidget(btn)
            if key in DEV_VIEWS:
                btn.hide()
                self.dev_buttons.append(btn)
            self.pages.addWidget(self._make_page(key, blocks))
        view_row.addStretch(1)
        self.view_buttons.idClicked.connect(self.pages.setCurrentIndex)
        self.view_buttons.button(0).setChecked(True)

        legend = QLabel("Paramètres, plages et listes de valeurs : tables du firmware G-System 4.02.")
        legend.setEnabled(False)
        # One scroll area for the whole page: settings are never squeezed.
        content = QWidget()
        layout = QVBoxLayout(content)
        layout.addLayout(header)
        layout.addWidget(self.panel)
        layout.addLayout(view_row)
        layout.addWidget(self.pages)
        layout.addWidget(legend)
        layout.addStretch(1)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.NoFrame)
        scroll.setWidget(content)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(scroll)
        self.open_slot(0)

    def set_dev_tools(self, visible: bool) -> None:
        for btn in self.dev_buttons:
            btn.setVisible(visible)
        if not visible and self.view_buttons.checkedButton() in self.dev_buttons:
            self.view_buttons.button(0).click()

    def rescale(self, base: QFont) -> None:
        """The front panel scales with the window; nothing to do for the zoom level."""

    def _make_page(self, key: str, blocks) -> QWidget:
        if key == "raw":
            table = RawTable()
            table.edited.connect(lambda f, v: self.set_field(f, v, f"Champ #{f}"))
            self.panels.append(table)
            return table
        if key == "compare":
            self.compare = ComparePanel(self)
            return self.compare
        content = QWidget()
        grid = QGridLayout(content)
        if key == "modifiers":
            for i, (title, fields) in enumerate((
                    ("En-tête du preset", HEADER_FIELDS),
                    ("Routage, niveaux et assignations (pas encore décodés)", range(NUMERIC_FIELDS, FIELD_COUNT)))):
                panel = RawPanel(title, fields)
                panel.edited.connect(lambda f, v: self.set_field(f, v, f"Champ #{f}"))
                self.panels.append(panel)
                grid.addWidget(panel, i, 0)
        else:
            compact = blocks is None
            chosen = BLOCKS if compact else [block(k) for k in blocks]
            for i, blk in enumerate(chosen):
                panel = BlockPanel(blk, columns=4 if compact else 6)
                panel.edited.connect(lambda f, v, b=blk: self.set_field(f, v, f"{b.label} · {describe_field(self.buffer.data, f)[1]}"))
                self.panels.append(panel)
                grid.addWidget(panel, i // 2 if compact else i, i % 2 if compact else 0)
        return content

    # Buffer handling

    def open_slot(self, slot: int) -> None:
        if self.buffer is not None and self.is_dirty() and slot != self.slot:
            answer = QMessageBox.question(
                self, "Preset modifié",
                f"Le preset « {self.buffer.name} » a été modifié sans être stocké.\n"
                "Stocker les modifications avant de changer de preset ?",
                QMessageBox.Save | QMessageBox.Discard | QMessageBox.Cancel)
            if answer == QMessageBox.Cancel:
                self._show_number(self.slot)
                return
            if answer == QMessageBox.Save:
                self.store()
        changed = slot != self.slot
        self.slot = slot
        self.level_states = {k: None for k in LEVEL_SWITCHES}
        self.stored = self.bank.preset(slot)
        self.undo_stack.clear()
        self._set_buffer(self.stored, send=False)
        self._show_number(slot)
        if changed and not self._from_unit:
            self.push_to_unit()

    def _live_toggled(self, on: bool) -> None:
        # Entering Live mode loads the edited preset into the unit so both match.
        if on:
            self.push_to_unit()
        self._refresh_panel()

    def push_to_unit(self) -> None:
        """Audition the edited preset: write all its parameters into the unit's edit buffer.

        Nothing is stored on the unit. Blocks whose id has not been learned are skipped.
        """
        if self.buffer is None or self.send_param is None or not self.live.isChecked():
            return
        skipped = []
        for blk in BLOCKS:
            block_id = self.block_ids.get(blk.key)
            if block_id is None:
                skipped.append(blk.label)
                continue
            # The type comes first: it selects which parameters the others are.
            for index, _param in blk.fields(self.buffer.data):
                self.send_param(block_id, index - blk.first_field, read_field(self.buffer.data, index))
        message = f"« {self.buffer.name} » chargé dans la mémoire de travail du G-System"
        if skipped:
            message += f" (blocs inconnus, non envoyés : {', '.join(skipped)})"
        self.notice.emit(message)

    def follow_unit(self, slot: int) -> None:
        """A preset was recalled on the G-System: show it, without sending it back."""
        if not self.live.isChecked() or slot == self.slot or not 0 <= slot < USER_SLOTS:
            return
        self._from_unit = True
        try:
            self.open_slot(slot)
        finally:
            self._from_unit = False

    def reload_if_showing(self, slot: int) -> None:
        """The bank slot changed under us (paste, import, undo): follow it if not edited."""
        if slot == self.slot and not self.is_dirty():
            self.open_slot(slot)

    def _show_number(self, slot: int) -> None:
        self._refresh_panel()

    def is_dirty(self) -> bool:
        if self.buffer is None or self.stored is None:
            return self.buffer is not self.stored
        return self.buffer.data != self.stored.data

    def _set_buffer(self, preset: Preset | None, send: bool = True) -> None:
        previous = self.buffer
        if send and previous is not None and preset is not None:
            self._send_changes(previous.data, preset.data)
        self.buffer = preset
        self.pages.setEnabled(preset is not None)
        if preset is not None:
            for panel in self.panels:
                panel.load(preset.data)
            self.compare.set_reference(self.slot, preset)
        self._refresh_panel()
        if preset is not None:
            self.buffer_changed.emit(preset)

    def _refresh_panel(self) -> None:
        preset = self.buffer
        leds: dict[str, bool | None] = {}
        enabled = {"up", "down", *(f"preset{i}" for i in range(1, 6))}
        for key in SWITCH_BLOCKS:
            field = block(key).enable_field(preset.data) if preset is not None else None
            if field is not None:
                leds[key] = read_field(preset.data, field) == 1
                enabled.add(key)
        live = self.live.isChecked() and self.send_param is not None
        for key in LEVEL_SWITCHES:
            leds[key] = self.level_states[key]
            if live:
                enabled.add(key)
        bank, position = bank_position(self.slot)
        for i in range(1, PRESETS_PER_BANK + 1):
            leds[f"preset{i}"] = position == i
        status = "Store pour garder" if self.is_dirty() else ""
        if live:
            status = ("LIVE  " + status).strip()
        self.panel.set_state(f"{bank:02d}", str(position), preset.name if preset else "", leds, enabled,
                             self.is_dirty(), status)
        self.panel.set_live(live)

    def _send_changes(self, before: bytes, after: bytes) -> None:
        if self._from_unit or not self.live.isChecked() or self.send_param is None:
            return
        for index, _old, new in diff_fields(before, after):
            blk = owner(index)
            if blk is not None and blk.key in self.block_ids and index != blk.count_field:
                self.send_param(self.block_ids[blk.key], index - blk.first_field, new)

    def apply_from_unit(self, block_id: int, param: int, value: int) -> None:
        """A switch or knob was used on the G-System: mirror it in the edit buffer."""
        if block_id == LEVELS_BLOCK_ID:
            for key, param_index in LEVEL_SWITCHES.items():
                if param_index == param:
                    self.level_states[key] = bool(value)
                    self._refresh_panel()
            return
        key = next((k for k, v in self.block_ids.items() if v == block_id), None)
        if key is None or self.buffer is None or not self.live.isChecked():
            return
        blk = block(key)
        if param >= blk.size:
            return
        self._from_unit = True
        try:
            self.set_field(blk.first_field + param, value, f"G-System · {blk.label}")
        finally:
            self._from_unit = False

    def _toggle_block(self, key: str, on: bool) -> None:
        blk = block(key)
        field = blk.enable_field(self.buffer.data) if self.buffer is not None else None
        if field is not None:
            self.set_field(field, int(on), f"{blk.label} {'on' if on else 'off'}")

    def press(self, key: str) -> None:
        """A footswitch of the virtual front panel was clicked."""
        if key in SWITCH_BLOCKS and self.buffer is not None:
            if self.live.isChecked() and key not in self.block_ids:
                self.notice.emit(f"{block(key).label} : numéro de bloc inconnu, le G-System ne suivra pas.")
            field = block(key).enable_field(self.buffer.data)
            if field is not None:
                self._toggle_block(key, read_field(self.buffer.data, field) != 1)
        elif key in LEVEL_SWITCHES:
            if self.send_param is not None and self.live.isChecked():
                on = not self.level_states[key]
                self.send_param(LEVELS_BLOCK_ID, LEVEL_SWITCHES[key], int(on))
                self.level_states[key] = on
                self._refresh_panel()
        elif key in ("up", "down"):
            # Like the unit: change bank, keep the position within the bank.
            bank, position = bank_position(self.slot)
            bank = (bank + (1 if key == "up" else -1)) % BANK_COUNT
            self.open_slot(bank * PRESETS_PER_BANK + position - 1)
        elif key.startswith("preset"):
            target = self.slot - self.slot % PRESETS_PER_BANK + int(key[-1]) - 1
            if target != self.slot:
                self.open_slot(target)

    def set_field(self, index: int, value: int, text: str) -> None:
        if self.buffer is None or read_field(self.buffer.data, index) == value:
            return
        try:
            data = write_field(self.buffer.data, index, value)
        except ValueError:
            return
        after = Preset(self.buffer.number, data, self.buffer.device_id)
        self.undo_stack.push(SetBufferCommand(self, self.buffer, after, f"{text} = {value}"))

    def rename_dialog(self) -> None:
        if self.buffer is None:
            return
        name, ok = QInputDialog.getText(self, "Renommer le preset", f"Nom ({NAME_LEN} caractères max.) :",
                                        text=self.buffer.name)
        name = name.strip()
        if not ok or name == self.buffer.name:
            return
        try:
            renamed = self.buffer.with_name(name)
        except SysexError:
            QMessageBox.warning(self, "Nom invalide", "Utilisez uniquement des caractères ASCII imprimables.")
            return
        self.undo_stack.push(SetBufferCommand(self, self.buffer, renamed, "Renommer"))

    def store(self) -> None:
        if self.buffer is not None and self.is_dirty():
            self.store_requested.emit(self.slot, self.buffer)
            self.stored = self.buffer
            self.undo_stack.setClean()
            self._set_buffer(self.buffer)

    def revert(self) -> None:
        if self.is_dirty():
            self.undo_stack.clear()
            self._set_buffer(self.stored)


class ComparePanel(QWidget):
    """Shows which fields differ between the edited preset and another slot.

    This is the main tool for identifying parameters: change one setting on the
    G-System, capture the preset again, and compare the two dumps.
    """

    def __init__(self, editor: PresetEditor) -> None:
        super().__init__(editor)
        self.editor = editor
        self.reference: Preset | None = None
        self.other = QSpinBox()
        self.other.setRange(1, USER_SLOTS)
        self.other.valueChanged.connect(self.refresh)
        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(("Champ", "Paramètre connu", "Preset édité", "Autre preset"))
        self.table.verticalHeader().hide()
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.summary = QLabel()
        row = QHBoxLayout()
        row.addWidget(QLabel("Comparer avec l'emplacement :"))
        row.addWidget(self.other)
        row.addWidget(self.summary, 1)
        layout = QVBoxLayout(self)
        layout.addLayout(row)
        layout.addWidget(self.table, 1)

    def set_reference(self, slot: int, preset: Preset) -> None:
        self.reference = preset
        if self.other.value() == slot + 1:
            self.other.setValue(min(USER_SLOTS, slot + 2))
        self.refresh()

    def refresh(self) -> None:
        other = self.editor.bank.preset(self.other.value() - 1)
        self.table.setRowCount(0)
        if self.reference is None or other is None:
            self.summary.setText("Emplacement vide.")
            return
        diffs = diff_fields(self.reference.data, other.data)
        name_changed = self.reference.data[:NAME_LEN] != other.data[:NAME_LEN]
        self.summary.setText(f"« {other.name} » : {len(diffs)} champ(s) différent(s)"
                             + (" + le nom" if name_changed else ""))
        self.table.setRowCount(len(diffs))
        for row, (index, a, b) in enumerate(diffs):
            blk_label, name = describe_field(self.reference.data, index)
            for col, text in enumerate((f"#{index}", f"{blk_label} · {name}".strip(" ·"), str(a), str(b))):
                self.table.setItem(row, col, QTableWidgetItem(text))
