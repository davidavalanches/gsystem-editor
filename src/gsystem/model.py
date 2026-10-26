"""Qt model of a 200-slot user bank, with undoable edits."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QAbstractTableModel, QModelIndex, Qt
from PySide6.QtGui import QBrush, QColor, QUndoCommand, QUndoStack

from .sqs import SqsFile, read_syx, write_syx
from .sysex import USER_SLOTS, Preset, SysexError, user_number

COLUMNS = ("N°", "Nom", "État")
COL_SLOT, COL_NAME, COL_STATUS = range(3)


def slot_label(slot: int) -> str:
    """Front-panel style number: user presets are shown 1..200."""
    return str(slot + 1)


class Library:
    """A user bank in memory, optionally backed by the .sqs file it came from."""

    def __init__(self, presets: list[Preset | None] | None = None, sqs: SqsFile | None = None,
                 path: Path | None = None) -> None:
        self.presets: list[Preset | None] = list(presets or [None] * USER_SLOTS)
        self.presets += [None] * (USER_SLOTS - len(self.presets))
        self.sqs = sqs
        self.path = path

    @classmethod
    def load(cls, path: Path) -> Library:
        if path.suffix.lower() == ".syx":
            presets: list[Preset | None] = [None] * USER_SLOTS
            loose = []
            for p in read_syx(path):
                if p.user_slot is not None and presets[p.user_slot] is None:
                    presets[p.user_slot] = p
                else:
                    loose.append(p)
            # Dumps without a user number (e.g. edit buffer) fill the first free slots.
            free = (i for i, p in enumerate(presets) if p is None)
            for p, slot in zip(loose, free):
                presets[slot] = p
            return cls(presets, None, path)
        sqs = SqsFile.load(path)
        return cls(sqs.user_presets(), sqs, path)

    def save_sqs(self, path: Path) -> Path:
        if self.sqs is None:
            raise SysexError("aucun fichier .sqs source : utilisez l'export .syx")
        for slot, preset in enumerate(self.presets):
            self.sqs.set_user_preset(slot, preset)
        return self.sqs.save(path)

    def export_syx(self, path: Path, slots: list[int] | None = None) -> Path:
        chosen = range(USER_SLOTS) if slots is None else slots
        presets = [self.presets[s].with_number(user_number(s)) for s in chosen if self.presets[s] is not None]
        return write_syx(path, presets)


class SetSlotsCommand(QUndoCommand):
    def __init__(self, model: BankModel, changes: dict[int, Preset | None], text: str) -> None:
        super().__init__(text)
        self.model = model
        self.after = changes
        self.before = {slot: model.library.presets[slot] for slot in changes}

    def _apply(self, values: dict[int, Preset | None]) -> None:
        for slot, preset in values.items():
            self.model.library.presets[slot] = preset
            self.model.slot_changed(slot)

    def redo(self) -> None:
        self._apply(self.after)

    def undo(self) -> None:
        self._apply(self.before)


class BankModel(QAbstractTableModel):
    def __init__(self, library: Library, parent=None) -> None:
        super().__init__(parent)
        self.library = library
        self.undo_stack = QUndoStack(self)

    def set_library(self, library: Library) -> None:
        self.beginResetModel()
        self.library = library
        self.undo_stack.clear()
        self.endResetModel()

    def preset(self, slot: int) -> Preset | None:
        return self.library.presets[slot]

    def set_slots(self, changes: dict[int, Preset | None], text: str) -> None:
        if changes:
            self.undo_stack.push(SetSlotsCommand(self, changes, text))

    def slot_changed(self, slot: int) -> None:
        self.dataChanged.emit(self.index(slot, 0), self.index(slot, len(COLUMNS) - 1))

    # Qt model API

    def rowCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else USER_SLOTS

    def columnCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(COLUMNS)

    def headerData(self, section, orientation, role=Qt.DisplayRole):
        if orientation == Qt.Horizontal and role == Qt.DisplayRole:
            return COLUMNS[section]
        return None

    def flags(self, index):
        base = Qt.ItemIsEnabled | Qt.ItemIsSelectable
        if index.column() == COL_NAME and self.preset(index.row()) is not None:
            base |= Qt.ItemIsEditable
        return base

    def data(self, index, role=Qt.DisplayRole):
        slot, col = index.row(), index.column()
        preset = self.preset(slot)
        if role in (Qt.DisplayRole, Qt.EditRole):
            if col == COL_SLOT:
                return slot_label(slot)
            if preset is None:
                return "— vide —" if col == COL_NAME else ""
            if col == COL_NAME:
                return preset.name
            if col == COL_STATUS:
                return "" if preset.checksum_ok else "⚠ somme"
        if role == Qt.ForegroundRole:
            if preset is None:
                return QBrush(QColor(128, 128, 128))
            if col == COL_STATUS and not preset.checksum_ok:
                return QBrush(QColor(220, 120, 0))
        if role == Qt.ToolTipRole and col == COL_STATUS and preset is not None and not preset.checksum_ok:
            return ("La somme de contrôle stockée ne correspond pas aux données.\n"
                    "Le preset a pu être modifié sans être recalculé, ou être corrompu.\n"
                    "Elle sera recalculée à l'enregistrement.")
        return None

    def setData(self, index, value, role=Qt.EditRole):
        preset = self.preset(index.row())
        if role != Qt.EditRole or index.column() != COL_NAME or preset is None:
            return False
        name = str(value).strip()
        if name == preset.name:
            return False
        try:
            renamed = preset.with_name(name)
        except SysexError:
            return False
        self.set_slots({index.row(): renamed}, f"Renommer « {preset.name} » en « {renamed.name} »")
        return True
