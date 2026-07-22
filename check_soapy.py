import SoapySDR
devs = SoapySDR.Device.enumerate()
print("count:", len(devs))
for i, d in enumerate(devs):
    try:
        print("device", i, dict(d))
    except Exception as e:
        print("device", i, "repr:", repr(d))
        print("error:", e)