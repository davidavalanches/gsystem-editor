"""Brushed-metal rotary knob, drawn with QPainter.

The look follows a machined knob: a recessed well, a conic-gradient metal cap
with a soft highlight, and a dark pointer bar. Two modes:

- continuous: drag vertically or use the wheel/arrow keys; the pointer sweeps
  from -135 to +135 degrees;
- toggle: two detents at -32 (off) and +32 degrees (on) with a pilot LED,
  animated with a slight overshoot.
"""

from __future__ import annotations

from PySide6.QtCore import Property, QEasingCurve, QPointF, QRectF, QSize, Qt, QVariantAnimation, Signal
from PySide6.QtGui import QColor, QConicalGradient, QPainter, QPainterPath, QPen, QRadialGradient
from PySide6.QtWidgets import QSizePolicy, QWidget

SWEEP = 135.0
TOGGLE_ANGLE = 32.0

METAL_HI, METAL_MID, METAL_LO = QColor(236, 237, 240), QColor(186, 189, 194), QColor(132, 136, 142)
WELL_HI, WELL_MID, WELL_LO = QColor(18, 19, 21), QColor(36, 38, 41), QColor(62, 65, 70)
TICK = QColor(120, 124, 130)
LED_ON, LED_OFF = QColor(255, 48, 36), QColor(96, 60, 20)


class Knob(QWidget):
    valueChanged = Signal(int)  # while turning
    released = Signal(int)  # value when the gesture ends

    def __init__(self, lo: int = 0, hi: int = 100, toggle: bool = False, parent=None) -> None:
        super().__init__(parent)
        self.lo, self.hi, self.toggle = lo, hi, toggle
        self._value = lo
        self._angle = self._target_angle(lo)
        self._drag_y: float | None = None
        self._drag_value = 0.0
        self._pressed = False
        self.setFocusPolicy(Qt.StrongFocus)
        self.setCursor(Qt.PointingHandCursor if toggle else Qt.SizeVerCursor)
        self.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Fixed)
        self._anim = QVariantAnimation(self, duration=350)
        self._anim.setEasingCurve(QEasingCurve(QEasingCurve.OutBack))
        self._anim.valueChanged.connect(self._set_angle)

    # Value

    def value(self) -> int:
        return self._value

    def setValue(self, value: int, animate: bool = False) -> None:
        value = max(self.lo, min(self.hi, int(value)))
        self._value = value
        target = self._target_angle(value)
        if animate:
            self._anim.stop()
            self._anim.setStartValue(self._angle)
            self._anim.setEndValue(target)
            self._anim.start()
        else:
            self._anim.stop()
            self._angle = target
            self.update()

    def _change(self, value: int, final: bool) -> None:
        value = max(self.lo, min(self.hi, value))
        if value != self._value:
            self.setValue(value, animate=self.toggle)
            self.valueChanged.emit(value)
        if final:
            self.released.emit(self._value)

    def _target_angle(self, value: int) -> float:
        if self.toggle:
            return TOGGLE_ANGLE if value > self.lo else -TOGGLE_ANGLE
        span = self.hi - self.lo
        return -SWEEP + (2 * SWEEP * (value - self.lo) / span if span else 0)

    def _set_angle(self, angle) -> None:
        self._angle = float(angle)
        self.update()

    angle = Property(float, lambda self: self._angle, _set_angle)

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
        self.update()
        if not self.toggle:
            self._drag_y = event.position().y()
            self._drag_value = float(self._value)

    def mouseMoveEvent(self, event) -> None:
        if self._drag_y is None:
            return
        # A full sweep for about 200 px; Shift for fine control.
        per_px = (self.hi - self.lo) / 200.0
        if event.modifiers() & Qt.ShiftModifier:
            per_px /= 10
        delta = (self._drag_y - event.position().y()) * per_px
        self._drag_y = event.position().y()
        self._drag_value = max(self.lo, min(self.hi, self._drag_value + delta))
        self._change(round(self._drag_value), final=False)

    def mouseReleaseEvent(self, event) -> None:
        if event.button() != Qt.LeftButton:
            return
        self._pressed = False
        if self.toggle:
            if self.rect().contains(event.position().toPoint()):
                self._change(self.hi if self._value == self.lo else self.lo, final=True)
        elif self._drag_y is not None:
            self._drag_y = None
            self.released.emit(self._value)
        self.update()

    def wheelEvent(self, event) -> None:
        steps = event.angleDelta().y() / 120
        if not steps:
            return
        step = 1 if self.toggle or self.hi - self.lo <= 50 else max(1, (self.hi - self.lo) // 100)
        target = self._value + (step if steps > 0 else -step)
        if self.toggle:
            target = self.hi if steps > 0 else self.lo
        self._change(target, final=True)
        event.accept()

    def keyPressEvent(self, event) -> None:
        keys = {Qt.Key_Up: 1, Qt.Key_Right: 1, Qt.Key_Down: -1, Qt.Key_Left: -1,
                Qt.Key_PageUp: 10, Qt.Key_PageDown: -10}
        if event.key() in keys:
            delta = keys[event.key()]
            if self.toggle:
                self._change(self.hi if delta > 0 else self.lo, final=True)
            else:
                self._change(self._value + delta * max(1, (self.hi - self.lo) // 100 if abs(delta) > 1 else 1),
                             final=True)
        elif self.toggle and event.key() in (Qt.Key_Space, Qt.Key_Return):
            self._change(self.hi if self._value == self.lo else self.lo, final=True)
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

        self._paint_ticks(p, c, well_r)

        # Recessed well.
        well = QRadialGradient(c, well_r)
        well.setColorAt(0.0, WELL_HI)
        well.setColorAt(0.75, WELL_MID)
        well.setColorAt(1.0, WELL_LO)
        p.setPen(Qt.NoPen)
        p.setBrush(well)
        p.drawEllipse(c, well_r, well_r)

        # Drop shadow under the cap.
        shadow = QRadialGradient(QPointF(c.x(), c.y() + knob_r * 0.08), knob_r * 1.12)
        shadow.setColorAt(0.8, QColor(0, 0, 0, 150))
        shadow.setColorAt(1.0, QColor(0, 0, 0, 0))
        p.setBrush(shadow)
        p.drawEllipse(QPointF(c.x(), c.y() + knob_r * 0.08), knob_r * 1.12, knob_r * 1.12)

        # Brushed metal cap: conic gradient turning with the knob, plus a fixed highlight.
        p.save()
        p.translate(c)
        p.rotate(self._angle)
        metal = QConicalGradient(QPointF(0, 0), 90)
        tones = (METAL_HI, METAL_MID, METAL_LO, METAL_MID, METAL_HI, METAL_MID, METAL_LO,
                 METAL_MID, METAL_HI, METAL_MID, METAL_LO, METAL_MID, METAL_HI)
        for i, tone in enumerate(tones):
            metal.setColorAt(i / (len(tones) - 1), tone)
        p.setBrush(metal)
        p.setPen(QPen(QColor(70, 72, 76), max(1.0, knob_r * 0.03)))
        p.drawEllipse(QPointF(0, 0), knob_r, knob_r)
        # Pointer bar.
        bar_w, bar_h = knob_r * 0.13, knob_r * 0.5
        bar = QRectF(-bar_w / 2, -knob_r + knob_r * 0.16, bar_w, bar_h)
        path = QPainterPath()
        path.addRoundedRect(bar, bar_w / 2, bar_w / 2)
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

        if self.toggle:
            self._paint_led(p, c, well_r)
        if self.hasFocus():
            p.setPen(QPen(QColor(70, 140, 255), 2))
            p.setBrush(Qt.NoBrush)
            p.drawEllipse(c, well_r + 2, well_r + 2)

    def _paint_ticks(self, p: QPainter, c: QPointF, well_r: float) -> None:
        angles = (-TOGGLE_ANGLE, TOGGLE_ANGLE) if self.toggle else (-SWEEP, SWEEP)
        p.setPen(QPen(TICK, max(1.5, well_r * 0.05), Qt.SolidLine, Qt.RoundCap))
        for a in angles:
            p.save()
            p.translate(c)
            p.rotate(a)
            p.drawLine(QPointF(0, -well_r * 0.98), QPointF(0, -well_r * 1.06))
            p.restore()

    def _paint_led(self, p: QPainter, c: QPointF, well_r: float) -> None:
        on = self._value > self.lo
        r = well_r * 0.09
        led = QPointF(c.x() + well_r * 0.82, c.y() - well_r * 0.82)
        if on:
            glow = QRadialGradient(led, r * 3.5)
            glow.setColorAt(0, QColor(255, 60, 40, 170))
            glow.setColorAt(1, QColor(255, 60, 40, 0))
            p.setPen(Qt.NoPen)
            p.setBrush(glow)
            p.drawEllipse(led, r * 3.5, r * 3.5)
        p.setPen(QPen(QColor(30, 20, 15), 1))
        p.setBrush(LED_ON if on else LED_OFF)
        p.drawEllipse(led, r, r)
