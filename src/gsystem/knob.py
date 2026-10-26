"""Brushed-metal rotary knob, drawn with QPainter.

The look follows a machined knob: a recessed well, a conic-gradient metal cap
with a soft highlight, and a dark pointer bar. Drag vertically (Shift for fine
steps) or use the wheel/arrow keys; the pointer sweeps from -135 to +135 degrees.
"""

from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QConicalGradient, QPainter, QPainterPath, QPen, QRadialGradient
from PySide6.QtWidgets import QSizePolicy, QWidget

SWEEP = 135.0

METAL_HI, METAL_MID, METAL_LO = QColor(236, 237, 240), QColor(186, 189, 194), QColor(132, 136, 142)
WELL_HI, WELL_MID, WELL_LO = QColor(18, 19, 21), QColor(36, 38, 41), QColor(62, 65, 70)
TICK = QColor(120, 124, 130)


class Knob(QWidget):
    valueChanged = Signal(int)  # while turning
    released = Signal(int)  # value when the gesture ends

    def __init__(self, lo: int = 0, hi: int = 100, parent=None) -> None:
        super().__init__(parent)
        self.lo, self.hi = lo, hi
        self._value = lo
        self._drag_y: float | None = None
        self._drag_value = 0.0
        self._pressed = False
        self.setFocusPolicy(Qt.StrongFocus)
        self.setCursor(Qt.SizeVerCursor)
        self.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Fixed)

    # Value

    def value(self) -> int:
        return self._value

    def setValue(self, value: int) -> None:
        self._value = max(self.lo, min(self.hi, int(value)))
        self.update()

    def _change(self, value: int, final: bool) -> None:
        value = max(self.lo, min(self.hi, value))
        if value != self._value:
            self.setValue(value)
            self.valueChanged.emit(value)
        if final:
            self.released.emit(self._value)

    def _angle(self) -> float:
        span = self.hi - self.lo
        return -SWEEP + (2 * SWEEP * (self._value - self.lo) / span if span else 0)

    def _step(self, big: bool = False) -> int:
        span = self.hi - self.lo
        return max(1, span // (10 if big else 100)) if span > 50 or big else 1

    # Geometry

    def sizeHint(self) -> QSize:
        em = self.fontMetrics().height()
        return QSize(int(em * 4.6), int(em * 4.6))

    def minimumSizeHint(self) -> QSize:
        em = self.fontMetrics().height()
        return QSize(int(em * 3.2), int(em * 3.2))

    # Interaction

    def mousePressEvent(self, event) -> None:
        if event.button() != Qt.LeftButton:
            return
        self._pressed = True
        self._drag_y = event.position().y()
        self._drag_value = float(self._value)
        self.update()

    def mouseMoveEvent(self, event) -> None:
        if self._drag_y is None:
            return
        # A full sweep for about 200 px; Shift for fine control.
        per_px = (self.hi - self.lo) / 200.0
        if event.modifiers() & Qt.ShiftModifier:
            per_px /= 10
        self._drag_value += (self._drag_y - event.position().y()) * per_px
        self._drag_value = max(self.lo, min(self.hi, self._drag_value))
        self._drag_y = event.position().y()
        self._change(round(self._drag_value), final=False)

    def mouseReleaseEvent(self, event) -> None:
        if event.button() != Qt.LeftButton:
            return
        self._pressed = False
        if self._drag_y is not None:
            self._drag_y = None
            self.released.emit(self._value)
        self.update()

    def wheelEvent(self, event) -> None:
        notches = event.angleDelta().y() / 120
        if notches:
            self._change(self._value + (self._step() if notches > 0 else -self._step()), final=True)
            event.accept()

    def keyPressEvent(self, event) -> None:
        keys = {Qt.Key_Up: (1, False), Qt.Key_Right: (1, False), Qt.Key_Down: (-1, False),
                Qt.Key_Left: (-1, False), Qt.Key_PageUp: (1, True), Qt.Key_PageDown: (-1, True)}
        if event.key() in keys:
            direction, big = keys[event.key()]
            self._change(self._value + direction * self._step(big), final=True)
        else:
            super().keyPressEvent(event)

    # Painting

    def paintEvent(self, _event) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        size = min(self.width(), self.height())
        c = QPointF(self.width() / 2, self.height() / 2)
        well_r = size * 0.47
        knob_r = well_r * 0.82 * (0.97 if self._pressed else 1.0)

        # Bezel ticks at both ends of the travel.
        p.setPen(QPen(TICK, max(1.5, well_r * 0.05), Qt.SolidLine, Qt.RoundCap))
        for a in (-SWEEP, SWEEP):
            p.save()
            p.translate(c)
            p.rotate(a)
            p.drawLine(QPointF(0, -well_r * 0.98), QPointF(0, -well_r * 1.06))
            p.restore()

        # Recessed well.
        well = QRadialGradient(c, well_r)
        well.setColorAt(0.0, WELL_HI)
        well.setColorAt(0.75, WELL_MID)
        well.setColorAt(1.0, WELL_LO)
        p.setPen(Qt.NoPen)
        p.setBrush(well)
        p.drawEllipse(c, well_r, well_r)

        # Drop shadow under the cap.
        sc = QPointF(c.x(), c.y() + knob_r * 0.08)
        shadow = QRadialGradient(sc, knob_r * 1.12)
        shadow.setColorAt(0.8, QColor(0, 0, 0, 150))
        shadow.setColorAt(1.0, QColor(0, 0, 0, 0))
        p.setBrush(shadow)
        p.drawEllipse(sc, knob_r * 1.12, knob_r * 1.12)

        # Brushed metal cap: conic gradient turning with the knob, plus a fixed highlight.
        p.save()
        p.translate(c)
        p.rotate(self._angle())
        metal = QConicalGradient(QPointF(0, 0), 90)
        tones = (METAL_HI, METAL_MID, METAL_LO, METAL_MID, METAL_HI, METAL_MID, METAL_LO,
                 METAL_MID, METAL_HI, METAL_MID, METAL_LO, METAL_MID, METAL_HI)
        for i, tone in enumerate(tones):
            metal.setColorAt(i / (len(tones) - 1), tone)
        p.setBrush(metal)
        p.setPen(QPen(QColor(70, 72, 76), max(1.0, knob_r * 0.03)))
        p.drawEllipse(QPointF(0, 0), knob_r, knob_r)
        bar_w, bar_h = knob_r * 0.13, knob_r * 0.5
        path = QPainterPath()
        path.addRoundedRect(QRectF(-bar_w / 2, -knob_r + knob_r * 0.16, bar_w, bar_h), bar_w / 2, bar_w / 2)
        p.setPen(QPen(QColor(255, 255, 255, 60), max(1.0, bar_w * 0.15)))
        p.setBrush(QColor(28, 29, 32))
        p.drawPath(path)
        p.restore()

        highlight = QRadialGradient(QPointF(c.x() - knob_r * 0.36, c.y() - knob_r * 0.48), knob_r * 0.9)
        highlight.setColorAt(0.0, QColor(255, 255, 255, 150))
        highlight.setColorAt(1.0, QColor(255, 255, 255, 0))
        p.setPen(Qt.NoPen)
        p.setBrush(highlight)
        p.drawEllipse(c, knob_r, knob_r)

        if self.hasFocus():
            p.setPen(QPen(QColor(70, 140, 255), 2))
            p.setBrush(Qt.NoBrush)
            p.drawEllipse(c, well_r + 2, well_r + 2)
