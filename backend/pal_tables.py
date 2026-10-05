"""
Radar color tables in GRLevelX-style .pal format: one `value r g b [a]` stop
per line, interpolated between stops. Value-anchored (a stop sits at a real
dBZ / kt / etc.), which is what makes the ramps match standard radar apps.

Tables adapted from SparkRadar (c) Tyler G (@tgranz), used with permission.
Several are themselves based on public tables at https://www.wxtools.org/
"""

PAL_TABLES: dict[str, str] = {
    # User-supplied default (2004 La Crosse BR). Exercises two-colour segments
    # and SolidColor holds -- see pal.ts for why those matter.
    "REF": """units: dBZ
step: 10
product: BR

color: -30 0 0 0
color: 0 105 126 108
solidcolor: 5 94 94 94
solidcolor: 10 131 131 131
solidcolor: 15 171 171 171
color: 20 0 225 255 0 200 255
color: 25 0 150 255 0 15 255
color: 30 0 255 0 0 200 0
color: 35 0 180 0 0 100 0
color: 40 255 250 0 255 200 0
color: 45 255 170 0 255 100 0
color: 50 255 0 0 150 0 0
color: 60 254 222 255 254 158 255
color: 65 255 99 255 223 11 226
color: 70 173 0 176 132 0 134
Solidcolor: 75 255 255 255""",
    # User-supplied default (BV_grl3v2). AUTHORED IN MPH with scale 2.237; the
    # stop values were converted to knots because our velocity already arrives
    # in knots, so using it raw would mislabel every speed.
    "VEL": """;=========================================
;   BV Color Table for GR3v2
;   Base Velocity

Product: BV
Units: KTS
; Scale: dropped -- our velocity already arrives in knots
step: 8

color: 64.00  164 089 068
color:  37.33  255 255 000
color:  30.93  254 154 039
color:  26.66  255 055 026
color: -21.33  000 255 000
color: -5.33  016 096 016
color: -0.0053 112 128 112

color:  0  144 128 144 

color: 5.33  112 000 000
color: 21.33  255 000 000
color: -26.66  082 247 089
color: -30.93  071 240 240
color: -64.00 000 000 255

RF: 128 0 208""",
    # User-supplied default (AWIPS_RHO, John Wright IV).
    "CC": """Product: CC
Units: RHO
Scale:  1
Step:   0.1

Color:  1.05  164   54  150
Color:  1.00  255  180  215
Color:  0.99   139   30   77  139   30   77
Color:  0.97   225    3    0
Color:  0.95   255  140    0
Color:  0.90   255  255    0
Color:  0.85   135  215   10
Color:  0.80    95  245  100
Color:  0.75   120  120  255
Color:  0.60    10   10  190
Color:  0.45    15   15  140
color:  0.00   15   15  140""",
    "KDP": """-2 0 0 0
-1 200 200 200
-0.5 255 100 100
0.5 255 0 0
2.3 255 0 255
3.5 0 255 0
5.8 255 255 0
10 255 255 255""",
    "DHC": """0 0 0 0
9.9 0 0 0
10 200 200 200
19.9 200 200 200
20 100 100 100
29.9 100 100 100
30 255 100 100
39.9 255 100 100
40 100 100 255
49.9 100 100 255
50 0 0 255
59.9 0 0 255
60 0 100 0
69.9 0 100 0
70 0 255 0
79.9 0 255 0
80 255 50 50
89.9 255 50 50
90 255 100 0
99.9 255 100 0
100 255 0 0
109.9 255 0 0
110 255 128 0
119.9 255 128 0
120 255 255 0
129.9 255 255 0
130 255 0 255
139.9 255 0 255
140 0 255 255
149.9 0 255 255
150 255 255 255""",
    # User-supplied default (Ben's SW). Authored in KTS, which is what our
    # spectrum width already is, so no rescale.
    "SW": """COLOR TABLE BY Los Capital Ben#9800

Product: SW
Units:   KTS
Step:    2
Scale:   1.9426     ; converts internal units (M/S) to KTS

RF:  117 0 117

color: 0 20 5 72
color: 2 50 20 140
color: 4 124 38 190
color: 7 218 55 120
color: 15 251 126 33
color: 18 255 255 0
color: 22 153 255 51
color: 30 0 153 230
color: 35 0 17 26
color: 40 255 255 255""",
    "ZDR": """-7 0 0 0
-3.5 0 0 0
0 255 255 255
0.5 0 0 255
2 0 255 0
2.5 255 255 0
4.5 255 0 0
6.5 255 100 100
8 255 255 255""",
    # Storm-relative velocity shares Base Velocity's ramp on purpose: it IS a
    # velocity field, just with the storm motion removed, so the same value
    # should read as the same colour. The old SRV table was *banded* -- pairs of
    # identical stops holding a flat colour per 10 kt -- which collapsed the
    # 720x1200 super-res grid into 13 shades and looked like low resolution.
    # Storm-relative velocity shares Base Velocity's ramp: same field with storm
    # motion removed, so the same value should read as the same colour.
    "SRV": """;=========================================
;   BV Color Table for GR3v2
;   Base Velocity

Product: BV
Units: KTS
; Scale: dropped -- our velocity already arrives in knots
step: 8

color: 64.00  164 089 068
color:  37.33  255 255 000
color:  30.93  254 154 039
color:  26.66  255 055 026
color: -21.33  000 255 000
color: -5.33  016 096 016
color: -0.0053 112 128 112

color:  0  144 128 144 

color: 5.33  112 000 000
color: 21.33  255 000 000
color: -26.66  082 247 089
color: -30.93  071 240 240
color: -64.00 000 000 255

RF: 128 0 208""",

    # --- Accumulation, in inches. Values are what the radar actually reports
    # once the x100 scale is applied (see nexrad_core._value_lut): a heavy
    # flash-flood hour is ~1-3", so the ramp is dense low and open at the top.
    # Differential phase, 0-360 deg. It WRAPS, so the ramp returns to its
    # starting hue at 360 -- a linear scale would show a false seam.
    "PHI": """Product: PHI
Units: DEG
Step: 30
Color:   0    40  40  40
Color:  30     0  90 200
Color:  60     0 180 220
Color:  90     0 200 120
Color: 120   120 220   0
Color: 150   230 230   0
Color: 180   250 170   0
Color: 210   240  90   0
Color: 240   220   0  60
Color: 270   200   0 160
Color: 300   140  40 210
Color: 330    70  70 220
Color: 360    40  40  40""",
    # Clutter filter power removed, dB: how much the clutter filter took out.
    # Low is normal; high means the filter worked hard there.
    "CFP": """Product: CFP
Units: DB
Step: 10
Color4:  -10   0   0   0   0
Color:     0  60  60  60
Color:    10   0 120 180
Color:    20   0 180 160
Color:    30  60 200  60
Color:    40 220 220   0
Color:    50 250 150   0
Color:    60 240  50  50
Color:    80 255 160 255""",
    "DAA": """Product: DAA
Units: IN
Step: 0.5
Color4: 0.00   0   0   0   0
Color:  0.01  90  90  90
Color:  0.10 160 160 160
Color:  0.25   0 100 255
Color:  0.50   0   0 220
Color:  0.75   0 200   0
Color:  1.00   0 255   0
Color:  1.50 255 255   0
Color:  2.00 255 150   0
Color:  2.50 255   0   0
Color:  3.00 160   0   0
Color:  4.00 255   0 255
Color:  5.00 255 255 255""",
    "DTA": """Product: DTA
Units: IN
Step: 1
Color4: 0.00   0   0   0   0
Color:  0.01  90  90  90
Color:  0.10 160 160 160
Color:  0.50   0 100 255
Color:  1.00   0   0 220
Color:  1.50   0 200   0
Color:  2.00   0 255   0
Color:  3.00 255 255   0
Color:  4.00 255 150   0
Color:  5.00 255   0   0
Color:  6.00 160   0   0
Color:  8.00 255   0 255
Color: 10.00 255 255 255""",
    # --- Echo tops, in kft. Real tops cap around 60-70 kft, so the table ends
    # there: an earlier 0-200 version left three quarters of the ramp unused
    # (that range belongs to the "topped" 150+value encoding, which MetPy's
    # DigitalEETMapper does not apply -- it hands back plain kft).
    # Legacy echo tops ramp, kept selectable. The default is now WCT_ET, the
    # published table for product code 135, read from palettes/ET.pal.
    # Matched to a reference colour bar: a
    # continuous spectrum, white at the floor through blue, cyan, green, yellow
    # and orange to red, then magenta and violet at the ceiling.
    #
    # Spans the product's own range, 0-70 kft, which is where NEXRAD EET tops
    # out -- so the violet end is reached by the tallest tops the product can
    # report rather than by nothing at all.
    "EET": """; Full-spectrum echo tops ramp, matched to the reference display.
Product: EET
Units: KFT
Step: 10
Color4: 0 255 255 255   0
Color:  3 255 255 255
Color:  7 205 225 250
Color: 11 150 200 250
Color: 15  85 190 250
Color: 19   0 205 240
Color: 23   0 215 175
Color: 27   0 200  85
Color: 31   0 178   0
Color: 35   0 150   0
Color: 39 105 200   0
Color: 43 190 225   0
Color: 47 240 235   0
Color: 51 255 190   0
Color: 55 255 120   0
Color: 59 255  45   0
Color: 63 235   0   0
Color: 66 225   0  95
Color: 68 215   0 200
Color: 70 150   0 210""",
    # --- Vertically integrated liquid, kg/m^2. Previously this product borrowed
    # the storm-total-accumulation table (0-10), so everything above 10 clamped
    # to one colour and the field was unreadable.
    "VIL": """Product: VIL
Units: KG/M2
Step: 10
Color4: 0   0   0   0   0
Color:  0.5 60  60  60
Color:  2  120 120 120
Color:  5    0 100 255
Color: 10    0   0 220
Color: 15    0 200   0
Color: 20    0 255   0
Color: 25  200 255   0
Color: 30  255 255   0
Color: 35  255 180   0
Color: 40  255 100   0
Color: 45  255   0   0
Color: 50  180   0   0
Color: 60  255   0 255
Color: 70  180   0 255
Color: 80  255 255 255""",
}


# ---------------------------------------------------------------------------
# Tables shipped as files in <repo>/palettes.
#
# These are the NEXRAD Level-3 palettes from NOAA's Weather and Climate
# Toolkit. They are read from disk rather than pasted in here so the folder
# stays the source of truth: drop a .pal in, restart, and it is live. A file
# whose stem matches a built-in id replaces it.
#
# The parser ignores `Scale:` on purpose. WCT applies it to convert the
# product's internal units (km, mm) into the display units; our decoder already
# hands over kft and inches, so honouring it here would scale the stops twice.
# ---------------------------------------------------------------------------
import os as _os
import sys as _sys


def _pal_dirs() -> list[str]:
    """Folders to read .pal files from, in the order a later one overrides.

    A source checkout has exactly one: <repo>/palettes. The packaged backend
    has none by that route -- PyInstaller unpacks the modules into a temp tree
    and __file__ points inside it, so walking up one level lands outside the
    bundle. That is not a cosmetic loss: nexrad_core subscripts the FILE_* ids
    directly at import, so an empty folder is a KeyError before the server
    binds a port. The bundled copy under sys._MEIPASS is the one that exists
    there, and the spec puts it there.

    The folder beside the executable comes last so the promise above survives
    packaging: drop a .pal in next to the exe, restart, and it is live.
    """
    here = _os.path.dirname(_os.path.abspath(__file__))
    dirs = [_os.path.join(_os.path.dirname(here), "palettes")]
    meipass = getattr(_sys, "_MEIPASS", None)
    if meipass:
        dirs.append(_os.path.join(meipass, "palettes"))
        dirs.append(_os.path.join(_os.path.dirname(_sys.executable), "palettes"))
    return dirs


def _load_pal_dir(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    if not _os.path.isdir(path):
        return out
    for name in sorted(_os.listdir(path)):
        if not name.lower().endswith(".pal"):
            continue
        try:
            with open(_os.path.join(path, name), encoding="utf-8", errors="replace") as fh:
                out[_os.path.splitext(name)[0]] = fh.read()
        except OSError:
            # A palette that will not read is not worth failing the server over;
            # the built-in table for that id stays in place.
            continue
    return out


# Namespaced, so a file never silently replaces a built-in of the same stem --
# CC, ZDR, KDP, SRV, SW and VIL all collide, and the built-ins are still wanted
# as alternatives (and, for CC, as the default: see below).
_FILE_TABLES: dict[str, str] = {}
for _d in _pal_dirs():
    _FILE_TABLES.update(_load_pal_dir(_d))

PAL_FILES: dict[str, str] = {f"FILE_{k}": v for k, v in _FILE_TABLES.items()}
# Normalized rotation (NROT): diverging around zero. Near zero is a faint grey
# so the field shows where there is velocity without burying the map;
# cyclonic (positive) runs green -> yellow at 1 (significant) -> red -> magenta
# at 2.5 (extreme) -> white; anticyclonic runs through the blues.
PAL_TABLES["NROT"] = """Product: NROT
Units: NROT
Step: 1
Color4: -5.0  200 170 255 255
Color4: -3.5  140  60 255 255
Color4: -2.0   60  80 255 255
Color4: -1.0    0 170 255 255
Color4: -0.5   70 130 160 220
Color4: -0.25  90 100 110 110
Color4:  0.0   70  70  70  70
Color4:  0.25  90 100 110 110
Color4:  0.5    0 160  60 230
Color4:  1.0  255 230   0 255
Color4:  1.5  255 140   0 255
Color4:  2.0  255  30  30 255
Color4:  2.5  230   0 200 255
Color4:  3.5  255 160 255 255
Color4:  5.0  255 255 255 255"""

PAL_TABLES.update(PAL_FILES)
