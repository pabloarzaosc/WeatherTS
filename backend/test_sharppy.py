"""Smoke test: does SHARPpy's computation core run on Python 3.13 + numpy 2.x?"""
import sys

print("python", sys.version.split()[0])

import numpy as np
print("numpy", np.__version__)

import sharppy.sharptab.profile as profile
import sharppy.sharptab.params as params
import sharppy.sharptab.interp as interp
import sharppy.sharptab.winds as winds
import sharppy.sharptab.utils as utils
print("sharppy imports OK")

# A simple, convectively unstable-ish synthetic sounding (14 levels).
pres = [1000., 925., 850., 700., 600., 500., 400., 300., 250., 200., 150., 100., 70., 50.]
hght = [110., 780., 1500., 3180., 4400., 5880., 7600., 9700., 10900., 12400., 14300., 16600., 18700., 20800.]
tmpc = [27., 22., 17., 6., -2., -12., -24., -40., -50., -58., -62., -68., -60., -55.]
dwpc = [22., 19., 14., 1., -8., -20., -34., -52., -60., -70., -75., -80., -78., -75.]
wdir = [180., 200., 220., 240., 250., 260., 265., 270., 275., 280., 280., 285., 290., 290.]
wspd = [10., 20., 30., 40., 45., 55., 65., 80., 90., 100., 95., 80., 60., 40.]

prof = profile.create_profile(
    profile='default',
    pres=np.array(pres), hght=np.array(hght),
    tmpc=np.array(tmpc), dwpc=np.array(dwpc),
    wspd=np.array(wspd), wdir=np.array(wdir),
    missing=-9999, strictQC=False,
)
print("profile built OK")

# Most-unstable parcel + CAPE
mupcl = params.parcelx(prof, flag=3)
print("MUCAPE = %.0f J/kg  MUCIN = %.0f" % (mupcl.bplus, mupcl.bminus))
sbpcl = params.parcelx(prof, flag=1)
print("SBCAPE = %.0f J/kg" % sbpcl.bplus)
mlpcl = params.parcelx(prof, flag=4)
print("MLCAPE = %.0f J/kg" % mlpcl.bplus)

# Effective inflow layer
eff_inflow = params.effective_inflow_layer(prof)
print("eff inflow (hPa):", eff_inflow)

# Kinematics
sfc_6km_shear = winds.wind_shear(prof, pbot=prof.pres[prof.sfc], ptop=interp.pres(prof, interp.to_msl(prof, 6000.)))
print("0-6 shear (u,v):", sfc_6km_shear)

# Storm motion (Bunkers) + SRH
srwind = params.bunkers_storm_motion(prof)
print("Bunkers RM/LM:", srwind)
srh1km = winds.helicity(prof, 0, 1000., stu=srwind[0], stv=srwind[1])
print("0-1km SRH:", srh1km)

# Composite  (stp_cin wants the shear MAGNITUDE in kt, not the u/v tuple)
ebwd_mag = utils.mag(sfc_6km_shear[0], sfc_6km_shear[1])
stp = params.stp_cin(mlpcl.bplus, srh1km[0], ebwd_mag, mlpcl.lclhght, mlpcl.bminus)
print("STP (cin): %.2f  [ebwd=%.0f kt]" % (stp, ebwd_mag))

print("\nALL GOOD — SHARPpy computes on py3.13 + numpy2")
