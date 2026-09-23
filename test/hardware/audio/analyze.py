#!/usr/bin/env python3
"""analyze.py rec.wav [rec2.wav ...] — what a recording of ref.wav (makeref.py) through a modem call looks like.
   Pure python. Reports level, clipping, DC, the 1 kHz bursts found (count, length, spacing), dropouts in the chord section
   and the noise floor of the silences. Frame = 20 ms."""
import math, struct, sys, wave
FRAME = 160  # 20 ms at 8 kHz
def read(path):
    with wave.open(path, 'rb') as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2 and w.getframerate() == 8000, (w.getnchannels(), w.getsampwidth(), w.getframerate())
        n = w.getnframes(); return list(struct.unpack('<%dh' % n, w.readframes(n)))
def dbfs(rms): return 20 * math.log10(rms / 32768) if rms > 0 else -120.0
def goertzel(x, freq):
    k = 2 * math.cos(2 * math.pi * freq / 8000); s1 = s2 = 0.0
    for v in x: s0 = v + k * s1 - s2; s2 = s1; s1 = s0
    return math.sqrt(max(s1 * s1 + s2 * s2 - k * s1 * s2, 0.0)) / (len(x) / 2)
def frames(x):
    out = []
    for i in range(0, len(x) - FRAME + 1, FRAME):
        f = x[i:i + FRAME]; rms = math.sqrt(sum(v * v for v in f) / FRAME)
        out.append({'t': i / 8000, 'rms': rms, 'db': dbfs(rms), 'k1': goertzel(f, 1000), 'k440': goertzel(f, 440), 'k2400': goertzel(f, 2400)})
    return out
def analyze(path):
    x = read(path); fr = frames(x); dur = len(x) / 8000
    dc = sum(x) / len(x)
    # 1 kHz bursts: frames where the 1 kHz component dominates (ratio to rms) and is loud
    is_burst = [f['k1'] > 0.6 * f['rms'] * math.sqrt(2) and f['db'] > -40 for f in fr]
    bursts = []; i = 0
    while i < len(fr):
        if is_burst[i]:
            j = i
            while j < len(fr) and is_burst[j]: j += 1
            if j - i >= 5: bursts.append((fr[i]['t'], (j - i) * 0.02, sum(f['db'] for f in fr[i:j]) / (j - i)))
            i = j
        else: i += 1
    # the chord section: from 0.8 s after the last burst's end, for 7.5 s (ref: 8 s); dropout = frame > 10 dB under the section median
    chord = None
    if bursts:
        t0 = bursts[-1][0] + bursts[-1][1] + 0.8; sec = [f for f in fr if t0 <= f['t'] < t0 + 7.5]
        if len(sec) > 50:
            dbs = sorted(f['db'] for f in sec); med = dbs[len(dbs) // 2]
            drops = [f for f in sec if f['db'] < med - 10]
            runs = 0; prev = None
            for f in drops:
                if prev is None or f['t'] - prev > 0.021: runs += 1
                prev = f['t']
            k2400 = sum(f['k2400'] for f in sec) / len(sec); k440 = sum(f['k440'] for f in sec) / len(sec); k1 = sum(f['k1'] for f in sec) / len(sec)
            chord = {'from': t0, 'median_db': med, 'min_db': dbs[0], 'max_db': dbs[-1], 'dropout_frames': len(drops), 'dropout_runs': runs,
                     'tone_balance_db': (20 * math.log10(k440 / k1) if k1 and k440 else None, 20 * math.log10(k2400 / k1) if k1 and k2400 else None)}
    # silences: frames under -55 dB before the first burst; and the noise floor = 10th percentile of all frames
    quiet = sorted(f['db'] for f in fr); floor = quiet[len(quiet) // 10]
    lead = [f for f in fr if bursts and f['t'] < bursts[0][0] - 0.1]
    lead_db = (sum(f['db'] for f in lead) / len(lead)) if lead else None
    # the tones span (to 1 s after the chord) and the speech that follows are reported apart: the speech sample is a loud GSM file
    split = int((chord['from'] + 8.5) * 8000) if chord else len(x)
    ref_part, speech = x[:split], x[split:]
    def stats(part):
        if not part: return 'none'
        pk = max(abs(v) for v in part); cl = sum(1 for v in part if abs(v) >= 32700)
        rms = math.sqrt(sum(v * v for v in part) / len(part))
        return f"peak {dbfs(pk):.1f} dBFS, rms {dbfs(rms):.1f} dB, clipped {cl} ({100 * cl / len(part):.3f} %)"
    print(f"== {path}: {dur:.2f} s, DC {dc:.0f}, noise floor (10th pct of 20 ms frames) {floor:.1f} dB")
    print(f"   tones part ({split / 8000:.1f} s): {stats(ref_part)}   |   speech part ({len(speech) / 8000:.1f} s): {stats(speech)}")
    print(f"   1 kHz bursts found: {len(bursts)} (ref: 8 x 0.30 s, 1.00 s apart, -12 dBFS)")
    for n, (t, l, db) in enumerate(bursts):
        gap = f", {t - bursts[n - 1][0]:.3f} s after the previous" if n else ''
        print(f"     #{n + 1} at {t:6.2f} s, {l:.2f} s, {db:6.1f} dB{gap}")
    if lead_db is not None: print(f"   lead-in silence: {lead_db:.1f} dB over {len(lead) * 0.02:.1f} s")
    if chord:
        tb = chord['tone_balance_db']
        print(f"   chord section from {chord['from']:.2f} s: median {chord['median_db']:.1f} dB (min {chord['min_db']:.1f}, max {chord['max_db']:.1f}), "
              f"dropouts {chord['dropout_frames']} frames in {chord['dropout_runs']} run(s); 440 Hz vs 1 kHz {tb[0]:+.1f} dB, 2400 Hz vs 1 kHz {tb[1]:+.1f} dB (ref: 0, 0)")
    else: print("   chord section: not found (no bursts?)")
for p in sys.argv[1:]: analyze(p)
