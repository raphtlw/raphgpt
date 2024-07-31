import os
from io import BytesIO
from pathlib import Path
from typing import Callable, Optional

import filetype
import requests
from beam import Image, PythonVersion, Volume, endpoint
from cuid2 import cuid_wrapper
from faster_whisper import WhisperModel

create_id: Callable[[], str] = cuid_wrapper()
TEMPDIR = Path("/tmp")


def download_resource_uri(file_url: str, prefix: str) -> tuple[Path, filetype.Type]:
    from base64 import b64decode

    # check is data-uri
    if file_url.startswith("data:"):
        header, encoded = file_url.split("base64,", 1)
        data = b64decode(encoded)
    else:
        response = requests.get(file_url)
        data = response.content

    kind = filetype.guess(data)
    assert kind, "Unable to guess file type"

    filepath = TEMPDIR / Path(f"{prefix}_{create_id()}.{kind.extension}")
    with open(filepath, mode="wb") as file:
        file.write(data)

    return filepath, kind


@endpoint(
    name="raphgpt",
    image=Image(
        python_version=PythonVersion.Python310,
        python_packages="./requirements.txt",
        commands=[
            "apt-get update",
            "apt-get install -y ffmpeg libsm6 libxext6",
        ],
    ),
    cpu=6,
    memory="8Gi",
)
def main(context, procedure: str, payload: dict):
    import cv2
    import ffmpeg
    import imutils
    import numpy as np

    match procedure:
        case "extract-video-frames":
            frames_path = TEMPDIR / Path(f"frames_{create_id()}")

            if not frames_path.exists():
                frames_path.mkdir()

            video, kind = download_resource_uri(payload["video_url"], "video")

            vinfo = ffmpeg.probe(video.as_posix())
            duration_s = float(vinfo["format"]["duration"])

            stream = ffmpeg.input(video.as_posix())
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
                    {"frame": a_frames[i], "mean": a_mean[i]}
                    for i in range(len(a_frames))
                ]

                sorted_frames = sorted(frame_data, key=lambda x: x["mean"])
                print(sorted_frames)

                selected_frames.append(max(frame_data, key=lambda x: x["mean"]))

            # read all file data and store them as base64
            from base64 import b64encode

            for i, frame_data in enumerate(selected_frames):
                path = Path(frame_data["frame"]["path"])
                del selected_frames[i]["frame"]["path"]
                encoded_image = b64encode(path.read_bytes())
                selected_frames[i]["frame"]["data"] = encoded_image.decode("utf-8")

            return selected_frames

        case "calculate-magnitude-spectrum":
            filepath = download_resource_uri(payload["image_url"], "frame")

            orig = cv2.imread(filepath.as_posix())
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

            return mean

        case "get-markdown-from-html":
            import markdownify

            md = markdownify(payload["html"])

            return {"result": md}

        case "limit-token-length":
            import tiktoken

            enc = tiktoken.encoding_for_model(payload["model"])
            res = enc.encode(payload["string"])
            capped = res[: payload["cap"]]
            return enc.decode(capped)

        case "exec":
            from contextlib import redirect_stdout
            from io import StringIO

            f = StringIO()
            with redirect_stdout(f):
                exec(
                    "\n".join(
                        [
                            "output = None",
                            payload["code"],
                            "if output:",
                            "   print(output)",
                        ]
                    )
                )
            s = f.getvalue()

            if len(s.strip()) == 0:
                return eval(payload["code"])

            return s


# This runs when the container first starts and is used to cache the model on disk
def load_whisper():
    model = WhisperModel(
        "large-v3", device="cuda", compute_type="float16", download_root="./cache"
    )

    return model


@endpoint(
    name="transcribe-audio",
    image=Image(
        python_version=PythonVersion.Python310,
        python_packages="./requirements.txt",
        commands=["apt-get update", "apt-get install -y ffmpeg"],
        base_image="nvidia/cuda:12.2.2-cudnn8-runtime-ubuntu22.04",
    ),
    on_start=load_whisper,
    cpu=1,
    memory="8Gi",
    gpu="T4",
    volumes=[
        Volume(mount_path="./cache", name="Cached Whisper Model"),
    ],
)
def transcribe_audio(context, file_url: str, lang: str = "en"):
    import ffmpeg

    model: WhisperModel = context.on_start_value

    filepath, kind = download_resource_uri(file_url, "audio")

    if kind.mime.split("/")[0] != "audio":
        # convert other file type to audio
        audio_filepath = Path(filepath.with_suffix(".mp3"))

        stream = ffmpeg.input(filepath.as_posix())
        stream = ffmpeg.output(stream, audio_filepath.as_posix())
        stream.run()
    else:
        audio_filepath = filepath

    segments, info = model.transcribe(
        audio_filepath.as_posix(), language=lang, vad_filter=True
    )

    print(
        "Detected language '%s' with probability %f"
        % (info.language, info.language_probability)
    )

    output = ""

    for segment in segments:
        print("[%.2fs -> %.2fs] %s" % (segment.start, segment.end, segment.text))
        output += segment.text

    output = output.strip()

    print(output)

    return output
