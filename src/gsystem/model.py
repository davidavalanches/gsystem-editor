"""Qt model of a 200-slot user bank, with undoable edits."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QAbstractTableModel, QModelIndex, Qt
from PySide6.QtGui import QBrush, QColor, QUndoCommand, QUndoStack

from .sqs import SqsFile, read_syx, write_syx
from .sysex import USER_SLOTS, Preset, SysexError, user_number

PRESETS_PER_BANK = 5
BANK_COUNT = USER_SLOTS // PRESETS_PER_BANK


def bank_position(slot: int) -> tuple[int, int]:
    """User presets are grouped in banks 00-39 of 5 presets (positions 1-5)."""
    return slot // PRESETS_PER_BANK, slot % PRESETS_PER_BANK + 1


def slot_label(slot: int) -> str:
    """Front-panel style location, e.g. "00-1"."""
    bank, position = bank_position(slot)
    return f"{bank:02d}-{position}"


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
    """Bank grid: one row per bank (00-39), one column per preset position (1-5)."""

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

    @staticmethod
    def slot_of(index) -> int:
        return index.row() * PRESETS_PER_BANK + index.column()

    def slot_index(self, slot: int):
        return self.index(slot // PRESETS_PER_BANK, slot % PRESETS_PER_BANK)

    def slot_changed(self, slot: int) -> None:
        index = self.slot_index(slot)
        self.dataChanged.emit(index, index)

    # Qt model API

    def rowCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else BANK_COUNT

    def columnCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else PRESETS_PER_BANK

    def headerData(self, section, orientation, role=Qt.DisplayRole):
        if role != Qt.DisplayRole:
            return None
        return f"Preset {section + 1}" if orientation == Qt.Horizontal else f"{section:02d}"

    def flags(self, index):
        base = Qt.ItemIsEnabled | Qt.ItemIsSelectable
        if self.preset(self.slot_of(index)) is not None:
            base |= Qt.ItemIsEditable
        return base

    def data(self, index, role=Qt.DisplayRole):
        slot = self.slot_of(index)
        preset = self.preset(slot)
        if role == Qt.DisplayRole:
            if preset is None:
                return "— vide —"
            return preset.name or "(sans nom)"
        if role == Qt.EditRole:
            return preset.name if preset else ""
        if role == Qt.ForegroundRole:
            if preset is None or not preset.name:
                return QBrush(QColor(128, 128, 128))
            if not preset.checksum_ok:
                return QBrush(QColor(220, 120, 0))
        if role == Qt.ToolTipRole:
            tip = slot_label(slot)
            if preset is not None and not preset.checksum_ok:
                tip += ("\nLa somme de contrôle stockée ne correspond pas aux données : "
                        "elle sera recalculée à l'enregistrement.")
            return tip
        return None

    def setData(self, index, value, role=Qt.EditRole):
        slot = self.slot_of(index)
        preset = self.preset(slot)
        if role != Qt.EditRole or preset is None:
            return False
        name = str(value).strip()
        if name == preset.name:
            return False
        try:
            renamed = preset.with_name(name)
        except SysexError:
            return False
        self.set_slots({slot: renamed}, f"Renommer « {preset.name} » en « {renamed.name} »")
        return True
