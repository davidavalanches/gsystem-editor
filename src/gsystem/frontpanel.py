"""Virtual front panel laid out like the G-System's control board.

Everything is drawn with QPainter in relative coordinates so the panel scales
to any window size. Footswitches emit ``pressed(key)``; the editor decides what
each one does.
"""

from __future__ import annotations

from dataclasses import dataclass

from PySide6.QtCore import QPointF, QRectF, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QFont, QLinearGradient, QPainter, QPainterPath, QPen, QRadialGradient
from PySide6.QtWidgets import QSizePolicy, QWidget

COLUMNS = 7
# Real control board is 2000x1054 for 6 columns; one extra column for Insert, EQ and Gate.
ASPECT = 1054 / (2000 * 7 / 6)

# 5x7 dot-matrix glyphs for the red preset display.
GLYPHS = {
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11111", "00010", "00100", "00010", "00001", "10001", "01110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "11110", "00001", "00001", "10001", "01110"),
    "6": ("00110", "01000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00010", "01100"),
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    " ": ("00000",) * 7,
}


@dataclass
class Switch:
    key: str
    title: str
    subtitle: str = ""
    caption: str = ""  # encoder caption under the top row
    arrow: str = ""  # "up" / "down" for the bank switches


TOP_ROW = (
    Switch("filter", "FILTER", "FORMANT | WAH | EFFECT FILTERS", "INPUT"),
    Switch("comp", "COMP", "COMPRESSOR ALGORITHM", "A"),
    Switch("loop1", "LOOP 1", "", "B"),
    Switch("loop2", "LOOP 2", "", "C"),
    Switch("loop3", "LOOP 3", "", "PAGE"),
    Switch("loop4", "LOOP 4", "", "OUTPUT"),
    Switch("insert", "INSERT", "LOOP 5"),
)
MIDDLE_ROW = (
    Switch("up", "UP", "", arrow="up"),
    Switch("mod", "MOD", "CHORUS | FLANGER | TREMOLO"),
    Switch("pitch", "PITCH", "WHAMMY | PITCH ALGORITHM"),
    Switch("delay", "DELAY", "HI-CLASS | TAPE ECHO | DYNAMIC"),
    Switch("reverb", "REVERB", "REVERB ALGORITHM"),
    Switch("boost", "BOOST", "PRESETABLE BOOST LEVEL"),
    Switch("eq", "EQ", "PARAMETRIC EQ"),
)
BOTTOM_ROW = (
    Switch("down", "DOWN", "", arrow="down"),
    Switch("preset1", "1", "SÉLECTION"),
    Switch("preset2", "2", "SÉLECTION"),
    Switch("preset3", "3", "SÉLECTION"),
    Switch("preset4", "4", "SÉLECTION"),
    Switch("preset5", "5", "SÉLECTION"),
    Switch("gate", "GATE", "NOISE GATE"),
)


class FrontPanel(QWidget):
    pressed = Signal(str)
    name_clicked = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        self.setMouseTracking(True)
        # key -> True (LED on), False (off), None (unknown) ; missing = no LED
        self.leds: dict[str, bool | None] = {}
        self.enabled_keys: set[str] = set()
        self.bank = "--"
        self.position = ""
        self.name = ""
        self.status = ""
        self.edited = False
        self.live = False
        self._hover: str | None = None
        self._down: str | None = None
        self._midi_flash = False
        self._flash_timer = QTimer(self, singleShot=True, interval=120)
        self._flash_timer.timeout.connect(self._end_flash)

    # Public API

    def set_state(self, bank: str, position: str, name: str, leds: dict[str, bool | None], enabled: set[str],
                  edited: bool, status: str = "") -> None:
        self.bank, self.position, self.name, self.leds, self.enabled_keys = bank, position, name, leds, enabled
        self.edited, self.status = edited, status
        self.update()

    def set_live(self, live: bool) -> None:
        self.live = live
        self.update()

    def flash_midi(self) -> None:
        self._midi_flash = True
        self._flash_timer.start()
        self.update()

    def _end_flash(self) -> None:
        self._midi_flash = False
        self.update()

    # Geometry

    def hasHeightForWidth(self) -> bool:
        return True

    def heightForWidth(self, width: int) -> int:
        return int(width * ASPECT)

    def sizeHint(self) -> QSize:
        return QSize(1000, int(1000 * ASPECT))

    def minimumSizeHint(self) -> QSize:
        return QSize(600, int(600 * ASPECT))

    def _panel_rect(self) -> QRectF:
        w = min(self.width(), self.height() / ASPECT)
        h = w * ASPECT
        return QRectF((self.width() - w) / 2, (self.height() - h) / 2, w, h)

    def _cell(self, row: int, col: int) -> QRectF:
        """Rows: 0 top switches, 1 middle switches, 2 bottom switches."""
        r = self._panel_rect()
        cw = (r.width() - 2 * r.width() * 0.022) / COLUMNS
        x = r.left() + r.width() * 0.022 + col * cw
        tops = (0.005, 0.44, 0.72)
        heights = (0.29, 0.28, 0.275)
        return QRectF(x, r.top() + r.height() * tops[row], cw, r.height() * heights[row])

    def _display_rect(self) -> QRectF:
        r = self._panel_rect()
        return QRectF(r.left() + r.width() * 0.022, r.top() + r.height() * 0.297, r.width() * 0.956,
                      r.height() * 0.127)

    def _switch_circle(self, row: int, col: int) -> QRectF:
        cell = self._cell(row, col)
        d = min(cell.width(), cell.height()) * (0.38 if row == 0 else 0.42)
        cy = cell.top() + cell.height() * (0.64 if row == 0 else 0.62 if row == 1 else 0.66)
        return QRectF(cell.center().x() - d / 2, cy - d / 2, d, d)

    def _rows(self):
        return ((0, TOP_ROW), (1, MIDDLE_ROW), (2, BOTTOM_ROW))

    def _hit(self, pos: QPointF) -> str | None:
        for row, switches in self._rows():
            for col, sw in enumerate(switches):
                c = self._switch_circle(row, col)
                if QPointF(pos - c.center()).manhattanLength() < c.width() * 0.7:
                    return sw.key
        lcd = self._lcd_rect()
        if lcd.contains(pos):
            return "__name__"
        return None

    def _lcd_rect(self) -> QRectF:
        d = self._display_rect()
        return QRectF(d.left() + d.width() * 0.34, d.top() + d.height() * 0.17, d.width() * 0.33, d.height() * 0.66)

    # Mouse

    def mouseMoveEvent(self, event) -> None:
        hit = self._hit(event.position())
        if hit != self._hover:
            self._hover = hit
            enabled = hit == "__name__" or hit in self.enabled_keys
            self.setCursor(Qt.PointingHandCursor if hit and enabled else Qt.ArrowCursor)
            self.update()

    def mousePressEvent(self, event) -> None:
        hit = self._hit(event.position())
        if hit and (hit == "__name__" or hit in self.enabled_keys):
            self._down = hit
            self.update()

    def mouseReleaseEvent(self, event) -> None:
        hit = self._hit(event.position())
        down, self._down = self._down, None
        self.update()
        if hit and hit == down:
            if hit == "__name__":
                self.name_clicked.emit()
            else:
                self.pressed.emit(hit)

    def leaveEvent(self, _event) -> None:
        self._hover = None
        self.update()

    # Painting

    def paintEvent(self, _event) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        r = self._panel_rect()
        self._paint_body(p, r)
        for row, switches in self._rows():
            for col, sw in enumerate(switches):
                self._paint_cell(p, row, col, sw)
        self._paint_display(p)

    def _font(self, size: float, bold: bool = True, family: str = "DejaVu Sans") -> QFont:
        f = QFont(family)
        f.setPixelSize(max(6, int(size)))
        f.setBold(bold)
        f.setLetterSpacing(QFont.PercentageSpacing, 104)
        return f

    def _paint_body(self, p: QPainter, r: QRectF) -> None:
        body = QLinearGradient(r.topLeft(), r.bottomLeft())
        body.setColorAt(0, QColor(214, 216, 218))
        body.setColorAt(0.5, QColor(196, 198, 201))
        body.setColorAt(1, QColor(186, 188, 191))
        p.setPen(QPen(QColor(120, 122, 125), max(1.0, r.width() * 0.002)))
        p.setBrush(body)
        p.drawRoundedRect(r, r.width() * 0.008, r.width() * 0.008)
        # Brushed aluminium: faint horizontal lines.
        p.setPen(QPen(QColor(255, 255, 255, 28), 1))
        step = max(2.0, r.height() / 260)
        y = r.top() + step
        i = 0
        while y < r.bottom():
            if i % 3:
                p.drawLine(QPointF(r.left() + 2, y), QPointF(r.right() - 2, y))
            y += step
            i += 1
        # Panel seams between the switch cells.
        p.setPen(QPen(QColor(150, 152, 156), max(1.0, r.width() * 0.0012)))
        for row in range(3):
            for col in range(1, COLUMNS):
                c = self._cell(row, col)
                top = c.top() if row != 2 else self._cell(1, col).top()
                if row == 1:
                    continue
                p.drawLine(QPointF(c.left(), top), QPointF(c.left(), c.bottom()))
        for col in range(1, COLUMNS):
            c = self._cell(1, col)
            p.drawLine(QPointF(c.left(), c.top()), QPointF(c.left(), self._cell(2, col).bottom()))
        # Screws in the corners.
        for fx, fy in ((0.011, 0.14), (0.989, 0.14), (0.011, 0.86), (0.989, 0.86)):
            c = QPointF(r.left() + r.width() * fx, r.top() + r.height() * fy)
            rad = r.width() * 0.0075
            grad = QRadialGradient(c, rad)
            grad.setColorAt(0, QColor(70, 70, 72))
            grad.setColorAt(1, QColor(20, 20, 22))
            p.setPen(Qt.NoPen)
            p.setBrush(grad)
            p.drawEllipse(c, rad, rad)
            p.setPen(QPen(QColor(110, 110, 112), rad * 0.25))
            p.drawLine(QPointF(c.x() - rad * 0.6, c.y()), QPointF(c.x() + rad * 0.6, c.y()))
            p.drawLine(QPointF(c.x(), c.y() - rad * 0.6), QPointF(c.x(), c.y() + rad * 0.6))

    def _paint_cell(self, p: QPainter, row: int, col: int, sw: Switch) -> None:
        cell = self._cell(row, col)
        circle = self._switch_circle(row, col)
        r = self._panel_rect()
        enabled = sw.key in self.enabled_keys
        ink = QColor(25, 25, 28) if enabled else QColor(120, 122, 126)
        preset_style = row == 2 and sw.key.startswith("preset")
        title_size = r.height() * (0.06 if preset_style else 0.04)

        # Title (and arrow for UP/DOWN).
        p.setPen(ink)
        p.setFont(self._font(title_size, family="DejaVu Sans"))
        if preset_style:
            title_rect = QRectF(cell.left() + cell.width() * 0.08, circle.top() - title_size * 1.7,
                                cell.width() * 0.3, title_size * 1.4)
            p.drawText(title_rect, Qt.AlignLeft | Qt.AlignVCenter, sw.title)
        else:
            title_rect = QRectF(cell.left(), cell.top() + cell.height() * 0.06, cell.width(), title_size * 1.4)
            if sw.arrow:
                title_rect = title_rect.adjusted(cell.width() * 0.25, 0, 0, 0)
                self._paint_arrow(p, QPointF(cell.left() + cell.width() * 0.25, title_rect.center().y()),
                                  title_size * 0.75, sw.arrow == "up", ink)
            p.drawText(title_rect, Qt.AlignCenter, sw.title)
        if sw.subtitle:
            p.setFont(self._font(r.height() * 0.0135, bold=False))
            if row == 0 or (row == 2 and not preset_style):
                sub = QRectF(cell.left(), title_rect.bottom(), cell.width(), title_size * 0.6)
            elif row == 1:
                sub = QRectF(cell.left(), circle.bottom() + cell.height() * 0.05, cell.width(), title_size * 0.6)
            else:
                sub = QRectF(title_rect.right(), title_rect.top(), cell.width() * 0.6, title_rect.height())
            p.drawText(sub, Qt.AlignLeft | Qt.AlignVCenter if preset_style else Qt.AlignCenter, sw.subtitle)
        if sw.caption:
            p.setPen(QColor(240, 242, 245))
            p.setFont(self._font(r.height() * 0.03, bold=False))
            cap = QRectF(cell.left(), circle.bottom() + cell.height() * 0.02, cell.width(), title_size * 1.1)
            p.drawText(cap, Qt.AlignCenter, sw.caption)

        # LED above the switch.
        if sw.key in self.leds:
            state = self.leds[sw.key]
            led_r = r.height() * 0.009
            c = QPointF(circle.center().x(), circle.top() - led_r * 1.8)
            color = QColor(255, 40, 30) if state else QColor(255, 190, 0) if state is None else QColor(90, 30, 28)
            if state:
                glow = QRadialGradient(c, led_r * 3.2)
                glow.setColorAt(0, QColor(255, 60, 40, 150))
                glow.setColorAt(1, QColor(255, 60, 40, 0))
                p.setPen(Qt.NoPen)
                p.setBrush(glow)
                p.drawEllipse(c, led_r * 3.2, led_r * 3.2)
            p.setPen(QPen(QColor(40, 20, 20), 1))
            p.setBrush(color)
            p.drawEllipse(c, led_r, led_r)
            if state is None:
                p.setPen(QColor(40, 40, 40))
                p.setFont(self._font(led_r * 1.8))
                p.drawText(QRectF(c.x() + led_r * 1.5, c.y() - led_r * 1.5, led_r * 4, led_r * 3),
                           Qt.AlignLeft | Qt.AlignVCenter, "?")

        self._paint_footswitch(p, circle, enabled, sw.key == self._down, sw.key == self._hover and enabled)

    def _paint_arrow(self, p: QPainter, center: QPointF, size: float, up: bool, ink: QColor) -> None:
        p.setPen(QPen(ink, size * 0.12))
        p.setBrush(Qt.NoBrush)
        p.drawEllipse(center, size, size)
        tri = QPainterPath()
        s = size * 0.55
        if up:
            tri.moveTo(center.x(), center.y() - s)
            tri.lineTo(center.x() - s, center.y() + s * 0.6)
            tri.lineTo(center.x() + s, center.y() + s * 0.6)
        else:
            tri.moveTo(center.x(), center.y() + s)
            tri.lineTo(center.x() - s, center.y() - s * 0.6)
            tri.lineTo(center.x() + s, center.y() - s * 0.6)
        tri.closeSubpath()
        p.setPen(Qt.NoPen)
        p.setBrush(ink)
        p.drawPath(tri)

    def _paint_footswitch(self, p: QPainter, c: QRectF, enabled: bool, down: bool, hover: bool) -> None:
        # Dark rubber ring.
        ring = QRadialGradient(c.center(), c.width() / 2)
        ring.setColorAt(0.75, QColor(45, 47, 50))
        ring.setColorAt(1, QColor(95, 98, 102))
        p.setPen(Qt.NoPen)
        p.setBrush(ring)
        p.drawEllipse(c)
        # Chrome dome.
        inset = c.width() * (0.16 if not down else 0.19)
        dome = c.adjusted(inset, inset, -inset, -inset)
        g = QRadialGradient(QPointF(dome.center().x() - dome.width() * 0.18, dome.top() + dome.height() * 0.3),
                            dome.width() * 0.75)
        base = 245 if enabled else 200
        g.setColorAt(0, QColor(base, base, base))
        g.setColorAt(0.45, QColor(base - 40, base - 38, base - 35))
        g.setColorAt(0.8, QColor(base - 120, base - 118, base - 115))
        g.setColorAt(1, QColor(base - 60, base - 58, base - 55))
        p.setBrush(g)
        p.setPen(QPen(QColor(30, 30, 32), max(1.0, c.width() * 0.02)))
        p.drawEllipse(dome)
        if hover:
            p.setPen(QPen(QColor(255, 255, 255, 140), max(1.5, c.width() * 0.03)))
            p.setBrush(Qt.NoBrush)
            p.drawEllipse(c.adjusted(-2, -2, 2, 2))

    def _paint_display(self, p: QPainter) -> None:
        d = self._display_rect()
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(10, 10, 12))
        p.drawRect(d)

        # MIDI activity and live indicators (in place of the input meters).
        led_r = d.height() * 0.07
        for i, (label, on, color) in enumerate((("MIDI", self._midi_flash, QColor(60, 220, 60)),
                                                ("DIRECT", self.live, QColor(255, 200, 0)))):
            x = d.left() + d.width() * (0.13 + i * 0.045)
            c = QPointF(x, d.top() + d.height() * 0.6)
            p.setBrush(color if on else color.darker(400))
            p.drawEllipse(c, led_r, led_r)
            p.setPen(QColor(220, 220, 220))
            p.setFont(self._font(d.height() * 0.11, bold=False))
            p.drawText(QRectF(x - d.width() * 0.03, d.top() + d.height() * 0.12, d.width() * 0.06, d.height() * 0.2),
                       Qt.AlignCenter, label)
            p.setPen(Qt.NoPen)

        # Red dot-matrix preset number.
        # Bank number in large dots, position within the bank as a small subscript.
        big = QRectF(d.left() + d.width() * 0.19, d.top() + d.height() * 0.14, d.width() * 0.08, d.height() * 0.72)
        pitch = self._paint_dots(p, self.bank[-2:].rjust(2), big)
        small_pitch = pitch * 0.5
        sub = QRectF(big.left() + pitch * 12, big.top() + pitch * 7 - small_pitch * 7, small_pitch * 5, small_pitch * 7)
        self._paint_dots(p, self.position[-1:], sub)
        if self.edited:
            p.setPen(QColor(200, 200, 200))
            p.setFont(self._font(d.height() * 0.1, bold=False))
            p.drawText(QRectF(d.left() + d.width() * 0.285, d.top() + d.height() * 0.05, d.width() * 0.05,
                              d.height() * 0.2), Qt.AlignLeft, "EDITED")

        # Green LCD with the preset name.
        lcd = self._lcd_rect()
        tab = QRectF(lcd.left(), d.top() + d.height() * 0.02, lcd.width() * 0.3, d.height() * 0.13)
        p.setFont(self._font(d.height() * 0.1))
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(70, 75, 85))
        p.drawRect(tab)
        p.setPen(QColor(230, 230, 235))
        p.drawText(tab, Qt.AlignCenter, "PRESET")
        lcd_bg = QLinearGradient(lcd.topLeft(), lcd.bottomLeft())
        lcd_bg.setColorAt(0, QColor(186, 222, 60))
        lcd_bg.setColorAt(1, QColor(160, 200, 40))
        p.setPen(Qt.NoPen)
        p.setBrush(lcd_bg)
        p.drawRect(lcd)
        p.setPen(QColor(30, 40, 10))
        mono = QFont("DejaVu Sans Mono")
        mono.setPixelSize(max(6, int(lcd.height() * 0.36)))
        p.setFont(mono)
        p.drawText(lcd.adjusted(lcd.width() * 0.03, 0, -lcd.width() * 0.03, -lcd.height() * 0.48),
                   Qt.AlignLeft | Qt.AlignBottom, self.name or "<EMPTY>")
        p.drawText(lcd.adjusted(lcd.width() * 0.03, lcd.height() * 0.5, -lcd.width() * 0.03, 0),
                   Qt.AlignLeft | Qt.AlignTop, self.status)
        if self._hover == "__name__":
            p.setPen(QPen(QColor(255, 255, 255, 160), 2))
            p.setBrush(Qt.NoBrush)
            p.drawRect(lcd.adjusted(-2, -2, 2, 2))

        # Product name on the right (the maker's logo is deliberately not reproduced).
        p.setPen(QColor(200, 202, 206))
        p.setFont(self._font(d.height() * 0.1, bold=False))
        p.drawText(QRectF(d.left() + d.width() * 0.7, d.top() + d.height() * 0.2, d.width() * 0.27, d.height() * 0.2),
                   Qt.AlignRight, "INTEGRATED EFFECTS + MANAGEMENT")
        p.setPen(QColor(150, 155, 162))
        p.setFont(self._font(d.height() * 0.3, bold=False))
        p.drawText(QRectF(d.left() + d.width() * 0.7, d.top() + d.height() * 0.45, d.width() * 0.27, d.height() * 0.45),
                   Qt.AlignRight | Qt.AlignVCenter, "G·SYSTEM")

    def _paint_dots(self, p: QPainter, text: str, rect: QRectF) -> float:
        """Draw text in 5x7 dots; returns the dot pitch used."""
        cols = 6 * len(text) - 1
        pitch = min(rect.width() / cols, rect.height() / 7)
        radius = pitch * 0.38
        p.setPen(Qt.NoPen)
        for ci, ch in enumerate(text):
            glyph = GLYPHS.get(ch, GLYPHS[" "])
            for y, line in enumerate(glyph):
                for x, bit in enumerate(line):
                    centre = QPointF(rect.left() + (ci * 6 + x + 0.5) * pitch, rect.top() + (y + 0.5) * pitch)
                    p.setBrush(QColor(255, 45, 30) if bit == "1" else QColor(45, 10, 8))
                    p.drawEllipse(centre, radius, radius)
        return pitch
