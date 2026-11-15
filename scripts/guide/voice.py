# Makes the voice-over clips for the tutorial with Kokoro (offline text-to-speech, Apache-2.0 model).
# Needs: pip install kokoro-onnx soundfile, and kokoro-v1.0.onnx + voices-v1.0.bin from
# https://github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0).
# Usage: python3 scripts/guide/voice.py <model_dir> <out_dir> [voice] [speed]
import json, os, re, subprocess, sys
import soundfile as sf
from kokoro_onnx import Kokoro

MODEL, OUT = sys.argv[1], sys.argv[2]
VOICE = sys.argv[3] if len(sys.argv) > 3 else 'af_heart'
SPEED = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
HERE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)
N = json.load(open(os.path.join(HERE, 'narration.json')))
CHAPTERS = ['Start your free trial', 'Company settings', 'Add your team', 'Masters', 'Care packs', 'Raise an RMA',
            'Send it to the OEM', 'Dispatch to the OEM', 'Back to the customer', 'Dashboard, reminders & reports', 'Backups & privacy']

def speakable(t):
    # Say letters where the model would otherwise read a word ("RMA" → "R M A").
    t = t.replace('&', 'and').replace('—', ',').replace('→', ',')
    t = re.sub(r'\bRMAs\b', 'R M As', t)
    t = re.sub(r'\bRMA\b', 'R M A', t)
    t = re.sub(r'\bUPI\b', 'U P I', t)
    return t

k = Kokoro(os.path.join(MODEL, 'kokoro-v1.0.onnx'), os.path.join(MODEL, 'voices-v1.0.bin'))
jobs = {'intro': N['intro'], 'agenda': N['agenda'], 'features': N['features'], 'end': N['end']}
for i, c in enumerate(CHAPTERS, 1):
    jobs[f'ch-{i}'] = N['chapter'].format(n=i, title=c)
for i, s in enumerate(N['steps']):
    jobs[f'step-{i:03d}'] = s
lengths = {}
for key, text in jobs.items():
    wav = os.path.join(OUT, key + '.wav')
    if not os.path.exists(wav):
        samples, sr = k.create(speakable(text), voice=VOICE, speed=SPEED, lang='en-us')
        tmp = wav + '.24k.wav'
        sf.write(tmp, samples, sr)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp, '-ar', '44100', '-ac', '1', wav], check=True)
        os.remove(tmp)
    lengths[key] = round(sf.info(wav).duration, 3)
    print(key, lengths[key], flush=True)
json.dump(lengths, open(os.path.join(OUT, 'lengths.json'), 'w'), indent=1)
print('voice clips:', len(lengths), 'total', round(sum(lengths.values())), 's')
