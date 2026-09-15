"""Private, bounded GigaAM CPU service. Audio is temporary and never logged."""
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import time

MAX_BYTES = 20 * 1024 * 1024
MAX_SECONDS = 180
SAMPLE_RATE = 16000
MODEL_NAME = 'multilingual_ctc'


def segments(samples):
    """Split near low-energy frames; keep every sample and respect GigaAM's 25s cap."""
    import numpy as np
    start = 0
    while len(samples) - start > 24 * SAMPLE_RATE:
        low = start + 15 * SAMPLE_RATE
        high = start + 23 * SAMPLE_RATE
        frames = samples[low:high].reshape(-1, 320)
        offset = int(np.argmin(np.mean(frames * frames, axis=1))) * 320 + 160
        end = low + offset
        yield samples[start:end]
        start = end
    yield samples[start:]


class Engine:
    def __init__(self):
        import torch
        import gigaam
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        self.model = gigaam.load_model(MODEL_NAME, device='cpu', fp16_encoder=False,
                                      download_root='/models')

    def transcribe(self, data):
        import numpy as np
        import soundfile as sf
        started = time.monotonic()
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'voice.ogg'
            source.write_bytes(data)
            result = subprocess.run(['ffmpeg','-nostdin','-v','error','-protocol_whitelist','file,pipe',
                '-i',str(source),'-t',str(MAX_SECONDS+1),'-f','f32le','-ac','1','-ar',str(SAMPLE_RATE),'pipe:1'],
                capture_output=True, timeout=25)
            if result.returncode:
                raise ValueError('invalid audio')
            samples = np.frombuffer(result.stdout, dtype='<f4')
            if len(samples) > MAX_SECONDS * SAMPLE_RATE:
                raise OverflowError('duration limit')
            if len(samples) < 1600 or not np.isfinite(samples).all():
                raise ValueError('invalid audio')
            texts = []
            for part in segments(samples):
                if time.monotonic() - started > 150:
                    raise TimeoutError('inference deadline')
                wav = Path(tmp) / 'segment.wav'
                sf.write(wav, part, SAMPLE_RATE)
                texts.append(self.model.transcribe(str(wav)).text)
            return ' '.join(texts).strip()


def handler(engine, secret):
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def answer(self, status, value):
            encoded = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            self.answer(200 if self.path == '/health' else 404,
                        {'model': MODEL_NAME, 'ready': True} if self.path == '/health' else {})

        def do_POST(self):
            self.connection.settimeout(20)
            if self.path != '/transcribe':
                return self.answer(404,{})
            if not hmac.compare_digest(self.headers.get('Authorization',''), 'Bearer '+secret):
                return self.answer(401,{})
            if self.headers.get('Content-Type') != 'audio/ogg':
                return self.answer(415,{})
            try:
                size = int(self.headers.get('Content-Length','0'))
            except ValueError:
                return self.answer(400,{})
            if size <= 0 or size > MAX_BYTES:
                return self.answer(413,{})
            if not lock.acquire(blocking=False):
                return self.answer(503,{'error':'busy'})
            started = time.monotonic()
            try:
                data = self.rfile.read(size)
                if len(data) != size or not data.startswith(b'OggS') or b'OpusHead' not in data:
                    return self.answer(422,{})
                text = engine.transcribe(data)
                self.answer(200,{'text':text,'model':MODEL_NAME})
                print(json.dumps({'event':'transcribed','seconds':round(time.monotonic()-started,3),
                                  'inputBytes':size,'outputChars':len(text)}),flush=True)
            except OverflowError:
                self.answer(413,{})
            except (ValueError, subprocess.TimeoutExpired):
                self.answer(422,{})
            except Exception:
                self.answer(503,{'error':'transcription failed'})
            finally:
                lock.release()
    return Handler


if __name__ == '__main__':
    secret = os.environ['GIGAAM_API_KEY']
    if len(secret) < 32:
        raise ValueError('GIGAAM_API_KEY must have at least 32 characters')
    engine = Engine()
    print(json.dumps({'event':'ready','model':MODEL_NAME}),flush=True)
    ThreadingHTTPServer(('0.0.0.0',8000),handler(engine,secret)).serve_forever()
