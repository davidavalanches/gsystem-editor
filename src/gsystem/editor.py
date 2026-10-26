"""Preset editor: virtual front panel, block switches and parameter views."""

from __future__ import annotations

from PySide6.QtCore import QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QFont, QFontDatabase, QFontMetricsF, QPainter, QPen, QUndoCommand, QUndoStack
from PySide6.QtWidgets import (
    QAbstractButton,
    QButtonGroup,
    QComboBox,
    QDial,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
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
    field_offset,
    read_field,
    write_field,
)
from .sysex import NAME_LEN, USER_SLOTS, Preset, SysexError

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


class BlockSwitch(QAbstractButton):
    """Round footswitch-style toggle with an LED ring."""

    def __init__(self, label: str, parent=None) -> None:
        super().__init__(parent)
        self.setText(label)
        self.setCheckable(True)
        self.setCursor(Qt.PointingHandCursor)

    def sizeHint(self) -> QSize:
        em = self.fontMetrics().height()
        return QSize(int(em * 5.5), int(em * 6.5))

    def paintEvent(self, _event) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        em = self.fontMetrics().height()
        diameter = min(self.width(), self.height() - em * 1.6) - 6
        circle = QRectF((self.width() - diameter) / 2, 3, diameter, diameter)
        enabled = self.isEnabled()
        on = self.isChecked() and enabled
        led = QColor(255, 60, 40) if on else QColor(70, 30, 30)
        if not enabled:
            led = QColor(90, 90, 90)
        p.setPen(QPen(led.lighter(130) if on else QColor(40, 40, 40), max(2.0, diameter * 0.08)))
        p.setBrush(QColor(55, 58, 62) if enabled else QColor(120, 120, 120))
        p.drawEllipse(circle)
        inner = circle.adjusted(diameter * 0.22, diameter * 0.22, -diameter * 0.22, -diameter * 0.22)
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(160, 165, 170) if not self.isDown() else QColor(120, 125, 130))
        p.drawEllipse(inner)
        led_rect = QRectF(circle.center().x() - em * 0.3, circle.top() - 1, em * 0.6, em * 0.6)
        p.setBrush(led)
        p.drawEllipse(led_rect)
        p.setPen(self.palette().windowText().color() if enabled else QColor(140, 140, 140))
        p.drawText(QRectF(0, circle.bottom() + 4, self.width(), em * 1.4), Qt.AlignCenter, self.text())


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
    buffer_changed = Signal(object)  # Preset, for live audition once MIDI send is validated

    def __init__(self, bank_model, parent=None) -> None:
        super().__init__(parent)
        self.bank = bank_model
        self.undo_stack = QUndoStack(self)
        self.slot = 0
        self.buffer: Preset | None = None
        self.stored: Preset | None = None

        # Virtual LCD: slot number and name.
        lcd = QFrame()
        lcd.setObjectName("lcd")
        lcd.setStyleSheet("#lcd { background: #0d1a0d; border: 3px solid #333; border-radius: 8px; }"
                          "#lcd QLabel, #lcd QLineEdit, #lcd QSpinBox { color: #9dff7a; background: transparent;"
                          " border: none; }")
        mono = QFontDatabase.systemFont(QFontDatabase.FixedFont)
        self.number = QSpinBox()
        self.number.setRange(1, USER_SLOTS)
        self.number.setFont(mono)
        self.number.valueChanged.connect(lambda v: self.open_slot(v - 1))
        self.name = QLineEdit()
        self.name.setMaxLength(NAME_LEN)
        self.name.setFont(mono)
        self.name.editingFinished.connect(self._rename)
        self.state = QLabel()
        lcd_layout = QHBoxLayout(lcd)
        lcd_layout.addWidget(self.number)
        lcd_layout.addWidget(self.name, 1)
        lcd_layout.addWidget(self.state)
        self._lcd_widgets = (self.number, self.name)
        self.rescale(self.font())

        store = QPushButton("Store")
        store.setToolTip("Enregistrer le preset modifié dans son emplacement de la banque")
        store.clicked.connect(self.store)
        revert = QPushButton("Revenir")
        revert.setToolTip("Abandonner les modifications non stockées")
        revert.clicked.connect(self.revert)

        header = QHBoxLayout()
        header.addWidget(lcd, 1)
        header.addWidget(store)
        header.addWidget(revert)

        # Block switches.
        self.switches: dict[str, BlockSwitch] = {}
        switch_row = QHBoxLayout()
        switch_row.addStretch(1)
        for key in SWITCH_BLOCKS:
            sw = BlockSwitch(block(key).label)
            sw.toggled.connect(lambda on, k=key: self._toggle_block(k, on))
            self.switches[key] = sw
            switch_row.addWidget(sw)
        switch_row.addStretch(1)

        # View selector and pages.
        self.view_buttons = QButtonGroup(self)
        view_row = QHBoxLayout()
        self.pages = QStackedWidget()
        self.panels: list = []
        for i, (key, label, blocks) in enumerate(VIEWS + (("raw", "Brut", None), ("compare", "Comparer", None))):
            btn = QPushButton(label, checkable=True)
            self.view_buttons.addButton(btn, i)
            view_row.addWidget(btn)
            self.pages.addWidget(self._make_page(key, blocks))
        view_row.addStretch(1)
        self.view_buttons.idClicked.connect(self.pages.setCurrentIndex)
        self.view_buttons.button(0).setChecked(True)

        legend = QLabel("Paramètres, plages et listes de valeurs : tables du firmware G-System 4.02.")
        layout = QVBoxLayout(self)
        layout.addLayout(header)
        layout.addLayout(switch_row)
        layout.addLayout(view_row)
        layout.addWidget(self.pages, 1)
        layout.addWidget(legend)
        self.open_slot(0)

    def rescale(self, base: QFont) -> None:
        """Keep the LCD larger than the rest of the UI at every zoom level."""
        mono = QFontDatabase.systemFont(QFontDatabase.FixedFont)
        mono.setPointSizeF(base.pointSizeF() * 2)
        mono.setBold(True)
        for widget in self._lcd_widgets:
            widget.setFont(mono)
        self.number.setMinimumWidth(QFontMetricsF(mono).horizontalAdvance("0000") + 40)

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
        grid.setRowStretch(grid.rowCount(), 1)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(content)
        return scroll

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
        self.slot = slot
        self.stored = self.bank.preset(slot)
        self.undo_stack.clear()
        self._set_buffer(self.stored)
        self._show_number(slot)

    def reload_if_showing(self, slot: int) -> None:
        """The bank slot changed under us (paste, import, undo): follow it if not edited."""
        if slot == self.slot and not self.is_dirty():
            self.open_slot(slot)

    def _show_number(self, slot: int) -> None:
        self.number.blockSignals(True)
        self.number.setValue(slot + 1)
        self.number.blockSignals(False)

    def is_dirty(self) -> bool:
        if self.buffer is None or self.stored is None:
            return self.buffer is not self.stored
        return self.buffer.data != self.stored.data

    def _set_buffer(self, preset: Preset | None) -> None:
        self.buffer = preset
        editable = preset is not None
        for w in (self.name, self.pages, *self.switches.values()):
            w.setEnabled(editable)
        for key, sw in self.switches.items():
            field = block(key).enable_field(preset.data) if editable else None
            sw.setEnabled(field is not None)
            sw.blockSignals(True)
            sw.setChecked(field is not None and read_field(preset.data, field) == 1)
            sw.blockSignals(False)
        self.name.setText(preset.name if preset else "— emplacement vide —")
        if preset is not None:
            for panel in self.panels:
                panel.load(preset.data)
            self.compare.set_reference(self.slot, preset)
        self.state.setText("● modifié" if self.is_dirty() else "")
        if preset is not None:
            self.buffer_changed.emit(preset)

    def _toggle_block(self, key: str, on: bool) -> None:
        blk = block(key)
        field = blk.enable_field(self.buffer.data) if self.buffer is not None else None
        if field is not None:
            self.set_field(field, int(on), f"{blk.label} {'on' if on else 'off'}")

    def set_field(self, index: int, value: int, text: str) -> None:
        if self.buffer is None or read_field(self.buffer.data, index) == value:
            return
        try:
            data = write_field(self.buffer.data, index, value)
        except ValueError:
            return
        after = Preset(self.buffer.number, data, self.buffer.device_id)
        self.undo_stack.push(SetBufferCommand(self, self.buffer, after, f"{text} = {value}"))

    def _rename(self) -> None:
        if self.buffer is None or self.name.text().strip() == self.buffer.name:
            return
        try:
            renamed = self.buffer.with_name(self.name.text().strip())
        except SysexError:
            self.name.setText(self.buffer.name)
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
