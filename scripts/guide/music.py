# Original background track for the tutorial video (synthesised here, so no copyright issues).
# Calm, steady lo-fi: soft pad chords, a plucked arpeggio, light kick and hats, 90 bpm.
# Usage: python3 scripts/guide/music.py <seconds> <out.wav>
import sys, wave
import numpy as np

SR = 44100
secs = float(sys.argv[1]); out = sys.argv[2]
bpm = 90; beat = 60 / bpm; bar = beat * 4
n = int(SR * secs)
mix = np.zeros(n)
rng = np.random.default_rng(7)

def note(f):
    return 440 * 2 ** ((f - 69) / 12)

def env(length, a=0.01, r=0.3):
    t = np.arange(length) / SR
    e = np.minimum(1, t / a) * np.exp(-t / r)
    return e

def add(sig, start):
    i = int(start * SR)
    if i >= n:
        return
    j = min(n, i + len(sig))
    mix[i:j] += sig[: j - i]

# I – V – vi – IV in D major, then a softer IV – I – V – vi turn
prog = [[50, 57, 62, 66], [45, 57, 61, 64], [47, 54, 59, 62], [43, 55, 59, 62],
        [43, 55, 59, 62], [50, 57, 62, 66], [45, 57, 61, 64], [47, 54, 59, 62]]
t = 0.0
k = 0
while t < secs:
    chord = prog[k % len(prog)]
    L = int(bar * SR)
    tt = np.arange(L) / SR
    # pad: detuned saws softened by averaging harmonics
    pad = np.zeros(L)
    for m in chord:
        f = note(m)
        for d in (-0.15, 0.15):
            for h in range(1, 6):
                pad += np.sin(2 * np.pi * f * (1 + d / 100) * h * tt) / (h * h)
    pe = np.minimum(1, tt / 0.6) * np.minimum(1, (bar - tt) / 0.5)
    add(0.018 * pad * pe, t)
    # bass on beats 1 and 3
    for b in (0, 2):
        bl = int(beat * 1.8 * SR)
        bt = np.arange(bl) / SR
        add(0.12 * np.sin(2 * np.pi * note(chord[0] - 12) * bt) * env(bl, 0.01, 0.5), t + b * beat)
    # plucked arpeggio, 8th notes
    arp = [chord[1] + 12, chord[2] + 12, chord[3] + 12, chord[2] + 12] * 2
    for s, m in enumerate(arp):
        pl = int(beat * 0.5 * SR)
        pt = np.arange(pl) / SR
        f = note(m)
        tone = np.sin(2 * np.pi * f * pt) + 0.3 * np.sin(2 * np.pi * 2 * f * pt)
        add(0.035 * tone * env(pl, 0.004, 0.18), t + s * beat / 2)
    # drums (enter after 4 bars)
    if k >= 4:
        for b in range(4):
            kl = int(0.25 * SR); kt = np.arange(kl) / SR
            if b in (0, 2):
                add(0.22 * np.sin(2 * np.pi * (55 + 90 * np.exp(-kt * 30)) * kt) * env(kl, 0.002, 0.12), t + b * beat)
            for h in (0, 0.5):
                hl = int(0.06 * SR)
                add(0.018 * rng.standard_normal(hl) * env(hl, 0.001, 0.02), t + (b + h) * beat)
            if b in (1, 3):
                sl = int(0.18 * SR)
                add(0.05 * rng.standard_normal(sl) * env(sl, 0.002, 0.06), t + b * beat)
    t += bar
    k += 1

# soft low-pass (moving average), fade in/out, normalise
mix = np.convolve(mix, np.ones(6) / 6, mode='same')
fade = int(3 * SR)
mix[:fade] *= np.linspace(0, 1, fade)
mix[-fade:] *= np.linspace(1, 0, fade)
mix = mix / (np.max(np.abs(mix)) + 1e-9) * 0.5
stereo = np.stack([mix, np.roll(mix, 220)], axis=1)
with wave.open(out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((stereo * 32767).astype(np.int16).tobytes())
print('saved', out, round(secs), 's')
