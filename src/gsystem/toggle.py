"""Pill-shaped on/off switch with a sliding knob, drawn with QPainter.

Grey track with "OFF" when off, blue track with "ON" when on; the white knob
slides between both ends.
"""

from __future__ import annotations

from PySide6.QtCore import Property, QEasingCurve, QRectF, QSize, Qt, QVariantAnimation, Signal
from PySide6.QtGui import QColor, QFont, QLinearGradient, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

TRACK_OFF, TRACK_ON = QColor(226, 228, 230), QColor(71, 168, 216)
TEXT_OFF, TEXT_ON = QColor(140, 143, 147), QColor(255, 255, 255)


class ToggleSwitch(QWidget):
    toggled = Signal(bool)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._checked = False
        self._pos = 0.0  # 0 = off, 1 = on
        self.setFocusPolicy(Qt.StrongFocus)
        self.setCursor(Qt.PointingHandCursor)
        self.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        self._anim = QVariantAnimation(self, duration=150)
        self._anim.setEasingCurve(QEasingCurve(QEasingCurve.InOutQuad))
        self._anim.valueChanged.connect(self._set_pos)

    def isChecked(self) -> bool:
        return self._checked

    def setChecked(self, checked: bool, animate: bool = False) -> None:
        self._checked = bool(checked)
        target = 1.0 if self._checked else 0.0
        self._anim.stop()
        if animate:
            self._anim.setStartValue(self._pos)
            self._anim.setEndValue(target)
            self._anim.start()
        else:
            self._set_pos(target)

    def toggle(self) -> None:
        self.setChecked(not self._checked, animate=True)
        self.toggled.emit(self._checked)

    def _set_pos(self, pos) -> None:
        self._pos = float(pos)
        self.update()

    position = Property(float, lambda self: self._pos, _set_pos)

    def sizeHint(self) -> QSize:
        em = self.fontMetrics().height()
        return QSize(int(em * 3.6), int(em * 1.6))

    def mouseReleaseEvent(self, event) -> None:
        if event.button() == Qt.LeftButton and self.rect().contains(event.position().toPoint()):
            self.toggle()

    def keyPressEvent(self, event) -> None:
        if event.key() in (Qt.Key_Space, Qt.Key_Return, Qt.Key_Enter):
            self.toggle()
        else:
            super().keyPressEvent(event)

    def paintEvent(self, _event) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        r = QRectF(self.rect()).adjusted(1.5, 1.5, -1.5, -1.5)
        h = r.height()
        radius = h / 2

        # Track, blending from grey to blue while sliding.
        t = self._pos
        track = QColor(
            round(TRACK_OFF.red() + (TRACK_ON.red() - TRACK_OFF.red()) * t),
            round(TRACK_OFF.green() + (TRACK_ON.green() - TRACK_OFF.green()) * t),
            round(TRACK_OFF.blue() + (TRACK_ON.blue() - TRACK_OFF.blue()) * t))
        path = QPainterPath()
        path.addRoundedRect(r, radius, radius)
        p.setPen(QPen(QColor(0, 0, 0, 40), 1))
        p.setBrush(track)
        p.drawPath(path)
        # Inset shadow along the top edge.
        inset = QLinearGradient(r.topLeft(), r.bottomLeft())
        inset.setColorAt(0, QColor(0, 0, 0, 45))
        inset.setColorAt(0.35, QColor(0, 0, 0, 0))
        p.setPen(Qt.NoPen)
        p.setBrush(inset)
        p.drawPath(path)

        # Label on the free side of the track.
        font = QFont(self.font())
        font.setPixelSize(max(7, int(h * 0.42)))
        font.setBold(True)
        p.setFont(font)
        knob_d = h - 4
        if self._checked:
            p.setPen(TEXT_ON)
            p.drawText(QRectF(r.left(), r.top(), r.width() - knob_d, h), Qt.AlignCenter, "ON")
        else:
            p.setPen(TEXT_OFF)
            p.drawText(QRectF(r.left() + knob_d, r.top(), r.width() - knob_d, h), Qt.AlignCenter, "OFF")

        # Sliding knob with a soft shadow.
        x = r.left() + 2 + (r.width() - knob_d - 4) * t
        knob = QRectF(x, r.top() + 2, knob_d, knob_d)
        p.setBrush(QColor(0, 0, 0, 50))
        p.drawEllipse(knob.translated(0, 1.2))
        grad = QLinearGradient(knob.topLeft(), knob.bottomLeft())
        grad.setColorAt(0, QColor(255, 255, 255))
        grad.setColorAt(1, QColor(236, 237, 239))
        p.setPen(QPen(QColor(0, 0, 0, 55), 1))
        p.setBrush(grad)
        p.drawEllipse(knob)
        if self.hasFocus():
            p.setPen(QPen(QColor(70, 140, 255), 2))
            p.setBrush(Qt.NoBrush)
            p.drawRoundedRect(QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5), radius + 1, radius + 1)

