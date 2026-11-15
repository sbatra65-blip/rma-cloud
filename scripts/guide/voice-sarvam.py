# Voice-over clips with Sarvam AI's Bulbul (Indian voices, Hinglish). Same output layout as voice.py, so
# video.py can use it with VOICE=<out_dir>.
# The API key is read from the SARVAM_API_KEY environment variable — never commit it.
# Usage: SARVAM_API_KEY=... python3 scripts/guide/voice-sarvam.py <narration.json> <out_dir> [speaker] [lang]
import base64, json, os, re, subprocess, sys, time, urllib.error, urllib.request

NARR, OUT = sys.argv[1], sys.argv[2]
SPEAKER = sys.argv[3] if len(sys.argv) > 3 else 'shubh_enhi_ads'
LANG = sys.argv[4] if len(sys.argv) > 4 else 'hi-IN'
KEY = os.environ['SARVAM_API_KEY']
os.makedirs(OUT, exist_ok=True)
N = json.load(open(NARR))

def speakable(t):
    # Letters spelled out so the voice says each one clearly ("O E M" was the clearest in tests).
    t = t.replace('TrackMyRMA', 'Track My R M A').replace('trackmyrma', 'Track My R M A')
    for a in ['RMA', 'OEM', 'PDF', 'UPI', 'CSV', 'QR']:
        t = re.sub(rf'\b{a}\b', ' '.join(a), t)
    t = re.sub(r'\bPO\b', 'P O', t)
    return t

def tts(text):
    body = json.dumps({'text': speakable(text), 'language_code': LANG, 'speaker': SPEAKER, 'model': 'bulbul:v4-flash', 'speech_sample_rate': 44100}).encode()
    for attempt in range(8):
        req = urllib.request.Request('https://api.sarvam.ai/text-to-speech', data=body, headers={'api-subscription-key': KEY, 'content-type': 'application/json'})
        try:
            r = json.loads(urllib.request.urlopen(req, timeout=180).read())
            return b''.join(base64.b64decode(a) for a in r['audios'])
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:200]
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(5 * (attempt + 1)); continue
            raise SystemExit(f'Sarvam {e.code}: {msg}')
    raise SystemExit('Sarvam kept failing')

jobs = {'intro': N['intro'], 'agenda': N['agenda'], 'features': N['features'], 'end': N['end']}
for i, c in enumerate(N.get('chapters', []), 1):
    jobs[f'ch-{i}'] = N['chapter'].format(n=i, title=c)
for i, s in enumerate(N['steps']):
    jobs[f'step-{i:03d}'] = s
lengths = {}
for key, text in jobs.items():
    wav = os.path.join(OUT, key + '.wav')
    dur = lambda: float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], capture_output=True, text=True).stdout)
    # The service sometimes returns a near-empty clip; anything faster than ~22 characters a second is made again.
    for attempt in range(4):
        if os.path.exists(wav) and len(text) / max(dur(), 0.01) <= 22:
            break
        raw = tts(text)
        tmp = wav + '.src.wav'
        open(tmp, 'wb').write(raw)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', wav], check=True)
        os.remove(tmp)
    d = dur()
    lengths[key] = round(d, 3)
    print(key, lengths[key], flush=True)
json.dump(lengths, open(os.path.join(OUT, 'lengths.json'), 'w'), indent=1)
print('voice clips:', len(lengths), 'total', round(sum(lengths.values())), 's')
