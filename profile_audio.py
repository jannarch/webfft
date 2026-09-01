import time
import cProfile
from core.audio_demodulator import AudioDemodulator
import numpy as np

d = AudioDemodulator()
# prime it
d.demodulate(np.random.randn(4096).astype(np.complex64), 2e6, 100e6, 101e6, 'FM')

def run_test():
    for _ in range(500):
        d.demodulate(np.random.randn(4096).astype(np.complex64), 2e6, 100e6, 101e6, 'FM')

cProfile.run("run_test()", sort="tottime")
