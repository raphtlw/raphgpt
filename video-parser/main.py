import base64
import os
import tempfile

import cv2
import ffmpeg
import mediapipe as mp
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from openai import OpenAI

# --- CONFIG ---
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("Set OPENAI_API_KEY")

# mediapipe face detector
mp_face = mp.solutions.face_detection.FaceDetection(
    model_selection=1, min_detection_confidence=0.5
)

# OpenAI Client
openai = OpenAI()


# --- QUALITY METRICS ---
def detect_faces(frame):
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    res = mp_face.process(rgb)
    return len(res.detections) if res.detections else 0


def exposure_score(gray):
    mean = gray.mean() / 255.0
    under = np.count_nonzero(gray < 10) / gray.size
    over = np.count_nonzero(gray > 245) / gray.size
    return max(0.0, 1.0 - abs(mean - 0.5) - (under + over))


def blur_score(gray):
    return cv2.Laplacian(gray, cv2.CV_64F).var() / 1000.0


def score_frame(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    b = blur_score(gray)
    f = detect_faces(frame)
    e = exposure_score(gray)
    return b * 0.5 + f * 0.3 + e * 0.2


def sample_and_score(video_path, step=10, max_frames=5):
    cap = cv2.VideoCapture(video_path)
    scored = []
    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % step == 0:
            scored.append((score_frame(frame), frame.copy()))
        idx += 1
    cap.release()
    # pick top-K
    scored.sort(key=lambda x: x[0], reverse=True)
    best = [f for _, f in scored[:max_frames]]
    jpgs = []
    for f in best:
        _, buf = cv2.imencode(".jpg", f)
        jpgs.append(buf.tobytes())
    return jpgs


def extract_audio(video_path, out_path):
    try:
        (
            ffmpeg.input(video_path)
            .output(out_path, ac=1, ar=16000, format="wav")
            .overwrite_output()
            .run(quiet=True)
        )

        return True
    except:
        print("Unable to extract audio")
        return False


def transcribe(wav_path: str, lang: str):
    with open(wav_path, "rb") as f:
        resp = openai.audio.transcriptions.create(
            model="gpt-4o-transcribe", file=f, language=lang
        )
    return resp.text


async def summarize(transcript, frames):
    system = {
        "role": "system",
        "content": (
            "You are an assistant that summarizes videos given the transcript and key frames. "
            "Use the transcript and the visual information in the frames to infer what happens in the video."
        ),
    }
    content_parts = []
    content_parts.append(
        {"type": "text", "text": f"Here is the transcript:\n{transcript}"}
    )
    content_parts.append(
        {
            "type": "text",
            "text": "Below are key frames from the video. Please infer what happens based on these frames:",
        }
    )
    for frame in frames:
        data_uri = f"data:image/jpeg;base64,{base64.b64encode(frame).decode()}"
        content_parts.append({"type": "image_url", "image_url": {"url": data_uri}})
    content_parts.append({"type": "text", "text": "Please give me a concise summary."})

    user = {"role": "user", "content": content_parts}
    resp = openai.chat.completions.create(model="o4-mini", messages=[system, user])
    return resp.choices[0].message.content


# --- FASTAPI APP ---
app = FastAPI()


@app.post("/analyze")
async def analyze_video(file: UploadFile = File(...), lang: str = "en"):
    if not file.filename.lower().endswith((".mp4", ".mov", ".mkv", ".avi")):
        raise HTTPException(400, "Unsupported file type")

    with tempfile.TemporaryDirectory() as tmp:
        wav_path = os.path.join(tmp, "aud.wav")
        video_path = os.path.join(tmp, "in.mp4")

        with open(video_path, "wb") as f:
            f.write(await file.read())

        frames = sample_and_score(video_path, step=10, max_frames=5)

        transcript = ""
        summary = ""
        has_audio = extract_audio(video_path, wav_path)
        if has_audio:
            transcript = transcribe(wav_path, lang)
            summary = await summarize(transcript, frames)

    frames_data = [
        f"data:image/jpeg;base64,{base64.b64encode(f).decode()}" for f in frames
    ]
    return JSONResponse(
        {"transcript": transcript, "frames": frames_data, "summary": summary}
    )
