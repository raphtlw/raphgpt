import os
from pathlib import Path
from typing import Callable

import cv2
import ffmpeg
import imutils
import numpy as np
from cuid2 import cuid_wrapper
from fastapi import FastAPI
from pydantic import BaseModel

create_id: Callable[[], str] = cuid_wrapper()

DATA_DIR = Path(os.getenv("DATA_DIR")).resolve()
if not DATA_DIR.exists():
    DATA_DIR.mkdir()

app = FastAPI()


@app.get("/")
async def root():
    return {"message": "Up and running"}


class ProcessVideoBody(BaseModel):
    file_path: str


@app.post("/processVideo")
async def processVideo(body: ProcessVideoBody):
    frames_path = DATA_DIR / Path(f"frames_{create_id()}")

    if not frames_path.exists():
        frames_path.mkdir()

    vinfo = ffmpeg.probe(body.file_path)
    duration_s = float(vinfo["format"]["duration"])

    stream = ffmpeg.input(body.file_path)
    stream = ffmpeg.output(
        stream, Path(frames_path / "%d.jpeg").as_posix(), **{"c:v": "png"}
    )
    stream.run()

    frame_paths = sorted(list(frames_path.iterdir()), key=lambda x: int(x.stem))
    frames = [
        {"path": x, "timestamp": (duration_s / len(frame_paths)) * int(x.stem)}
        for x in frame_paths
    ]

    # split video into segments
    chunks = np.array_split(frames, 6)

    selected_frames = []

    for chunk in chunks:
        a_frames = []
        a_mean = []

        for frame in chunk:
            orig = cv2.imread(Path(frame["path"]).as_posix())
            orig = imutils.resize(orig, width=500)
            image = cv2.cvtColor(orig, cv2.COLOR_BGR2GRAY)

            # radius around centerpoint of image for which low fft
            # frequencies will be removed.
            size = 60

            # grab the dimensions of the image and use the dimensions to
            # derive the center (x, y)-coordinates
            (h, w) = image.shape
            (cX, cY) = (int(w / 2.0), int(h / 2.0))

            # compute the FFT to find the frequency transform, then shift
            # the zero frequency component (i.e., DC component located at
            # the top-left corner) to the center where it will be more
            # easy to analyze
            fft = np.fft.fft2(image)
            fftShift = np.fft.fftshift(fft)

            # zero-out the center of the FFT shift (i.e., remove low
            # frequencies), apply the inverse shift such that the DC
            # component once again becomes the top-left, and then apply
            # the inverse FFT
            fftShift[cY - size : cY + size, cX - size : cX + size] = 0
            fftShift = np.fft.ifftshift(fftShift)
            recon = np.fft.ifft2(fftShift)

            # compute the magnitude spectrum of the reconstructed image,
            # then compute the mean of the magnitude values
            magnitude = 20 * np.log(np.abs(recon))
            mean = np.mean(magnitude)

            # instead of defining a specific threshhold, clamp the values,
            # then take the clearest frame
            a_frames.append(frame)
            a_mean.append(mean)

        a_mean = np.array(a_mean)

        # clamp mean values of analyzed from 1 to 0
        norm = np.linalg.norm(a_mean)
        a_mean = a_mean / norm

        frame_data = [
            {"frame": a_frames[i], "mean": a_mean[i]} for i in range(len(a_frames))
        ]

        sorted_frames = sorted(frame_data, key=lambda x: x["mean"])
        print(sorted_frames)

        selected_frames.append(max(frame_data, key=lambda x: x["mean"]))

    return selected_frames
