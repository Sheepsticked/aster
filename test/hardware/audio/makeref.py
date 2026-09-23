#!/usr/bin/env python3
"""ref.wav: 8 kHz mono 16-bit reference for the modem audio check.
   0-1 s silence | 1-9 s eight 1 kHz bursts, 300 ms every 1000 ms, -12 dBFS | 9-17 s three-tone chord (440+1000+2400 Hz),
   -12 dBFS | 17-18 s silence. No numpy: plain math."""
import math, struct, sys, wave
RATE = 8000
def tone(freqs, seconds, dbfs):
    amp = 32767 * 10 ** (dbfs / 20) / len(freqs)
    return [sum(amp * math.sin(2 * math.pi * f * n / RATE) for f in freqs) for n in range(int(seconds * RATE))]
def silence(seconds): return [0.0] * int(seconds * RATE)
samples = silence(1.0)
for _ in range(8): samples += tone([1000], 0.3, -12) + silence(0.7)
samples += tone([440, 1000, 2400], 8.0, -12) + silence(1.0)
out = sys.argv[1] if len(sys.argv) > 1 else 'ref.wav'
with wave.open(out, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
    w.writeframes(struct.pack('<%dh' % len(samples), *(max(-32768, min(32767, int(round(x)))) for x in samples)))
print(out, len(samples) / RATE, 's')
