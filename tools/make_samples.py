"""Generate two short synthetic webinar recordings for testing.

samples/speaker.mp4       1920x1080 "speaker" camera with speech audio
samples/presentation.mp4  1920x1080 slides; recording started PRES_LEAD seconds
                          earlier than the speaker camera (so sync offset = +PRES_LEAD)

Both videos show the *master* time (speaker time) in the corner so sync can be
checked visually in exported frames. Requires macOS `say`, ffmpeg, OpenCV.
"""
import math
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

OUT = Path(__file__).resolve().parent.parent / "samples"
OUT.mkdir(exist_ok=True)
FPS = 30
W, H = 1920, 1080
PRES_LEAD = 4.0  # presentation recording starts 4 s before the speaker camera

SCRIPT = """
Welcome everyone, and thanks for joining today's webinar about email marketing for small businesses.
Before we start, let me ask you a question. Why do most small business newsletters get ignored?
Here is the surprising answer. It is not because people hate email. It is because the first line is boring.
The biggest mistake I see is starting every email with "Hope you are doing well". Nobody cares.
Instead, open with a specific problem your reader has right now. For example, "Your coffee is getting cold because your inbox is a mess."
That one change doubled the open rate for one of my clients in just three weeks.
Okay, let's move to the next slide and talk about timing.
So, um, there are a lot of opinions about timing, and honestly most of them are, you know, kind of the same.
Here is a practical tip you can use today. Send your email at the moment your customer is waiting for something. Lunch breaks work surprisingly well.
Most people think more emails means more unsubscribes. Actually, the data says the opposite when every email is useful.
Let me tell you a quick story. A bakery I worked with sent one email a week with a single recipe tip. Within six months, their weekend sales grew by forty percent.
The lesson is simple. Give value first, and sell second.
Alright, let's look at the last slide. Three things to remember.
Write a specific first line. Send when people are waiting. And always give one useful idea per email.
Thank you so much for being here today. See you next time.
""".strip()

SLIDES = [
    ("Email Marketing for Small Businesses", ["Webinar  |  Spring session"]),
    ("Why newsletters get ignored", ["It's not email fatigue", "It's a boring first line", "Open with a specific problem"]),
    ("Case study", ["One subject-line change", "2x open rate in 3 weeks"]),
    ("Timing", ["Send when people are waiting", "Lunch breaks work well", "Useful > frequent"]),
    ("Story: The Bakery", ["1 recipe tip per week", "+40% weekend sales in 6 months", "Give value first, sell second"]),
    ("Three things to remember", ["1. Specific first line", "2. Send when people wait", "3. One useful idea per email"]),
]


def run(cmd):
    print("+", " ".join(map(str, cmd)))
    subprocess.run(cmd, check=True)


def put_center(img, text, y, scale, color, thick):
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_DUPLEX, scale, thick)
    cv2.putText(img, text, ((img.shape[1] - tw) // 2, y), cv2.FONT_HERSHEY_DUPLEX, scale, color, thick, cv2.LINE_AA)


def stamp(img, master_t, label):
    txt = f"{label}  T={master_t:06.2f}"
    cv2.rectangle(img, (20, 20), (640, 90), (0, 0, 0), -1)
    cv2.putText(img, txt, (36, 72), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 255, 255), 3, cv2.LINE_AA)


def encode(path, frames_iter, n_frames, audio):
    p = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS),
         "-i", "-", "-i", str(audio), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast",
         "-crf", "23", "-pix_fmt", "yuv420p", "-g", "60", "-c:a", "aac", "-b:a", "128k", "-shortest", str(path)],
        stdin=subprocess.PIPE)
    for i in range(n_frames):
        p.stdin.write(frames_iter(i).tobytes())
    p.stdin.close()
    if p.wait():
        sys.exit("ffmpeg failed")


def main():
    aiff = OUT / "speech.aiff"
    run(["say", "-r", "175", "-o", str(aiff), SCRIPT])
    speech = OUT / "speech.wav"
    run(["ffmpeg", "-y", "-v", "error", "-i", str(aiff), "-ar", "48000", "-ac", "1", str(speech)])
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                str(speech)], capture_output=True, text=True).stdout)
    total = dur + 2.0
    print(f"speech duration {dur:.1f}s")

    # Speaker audio: 1 s silence + speech. Presentation audio: PRES_LEAD s extra silence, quieter
    spk_a = OUT / "spk_audio.wav"
    run(["ffmpeg", "-y", "-v", "error", "-i", str(speech), "-af", "adelay=1000,apad=pad_dur=1", "-t", f"{total}", str(spk_a)])
    pres_a = OUT / "pres_audio.wav"
    run(["ffmpeg", "-y", "-v", "error", "-i", str(speech), "-af",
         f"adelay={int((1 + PRES_LEAD) * 1000)},volume=0.5,apad=pad_dur=1", "-t", f"{total + PRES_LEAD}", str(pres_a)])

    # Speaker camera: warm background, a "person" (head + body) that sways a little.
    bg = np.zeros((H, W, 3), np.uint8)
    for y in range(H):
        bg[y, :] = (60 + y * 40 // H, 80 + y * 30 // H, 120 + y * 50 // H)

    def speaker_frame(i):
        t = i / FPS
        img = bg.copy()
        cx = int(W * 0.58 + 40 * math.sin(t * 0.7))  # person is right of centre
        cy = int(H * 0.40 + 10 * math.sin(t * 1.3))
        cv2.ellipse(img, (cx, cy + 420), (300, 260), 0, 180, 360, (40, 40, 40), -1)   # body
        cv2.circle(img, (cx, cy), 130, (150, 180, 220), -1)                               # face
        cv2.circle(img, (cx - 45, cy - 20), 14, (30, 30, 30), -1)
        cv2.circle(img, (cx + 45, cy - 20), 14, (30, 30, 30), -1)
        mouth = 8 + int(18 * abs(math.sin(t * 9)))
        cv2.ellipse(img, (cx, cy + 55), (40, mouth), 0, 0, 360, (40, 40, 140), -1)
        put_center(img, "SPEAKER CAMERA", H - 60, 1.6, (255, 255, 255), 3)
        stamp(img, t, "SPK")
        return img

    # Slides change at fixed master times
    slide_times = [0, 9, 30, 52, 76, 98]

    def pres_frame(i):
        pt = i / FPS
        mt = pt - PRES_LEAD  # master time
        img = np.full((H, W, 3), 245, np.uint8)
        k = 0
        for j, st in enumerate(slide_times):
            if mt >= st:
                k = j
        title, bullets = SLIDES[k]
        cv2.rectangle(img, (0, 0), (W, 170), (120, 60, 20), -1)
        put_center(img, title, 115, 2.2, (255, 255, 255), 4)
        for b, line in enumerate(bullets):
            cv2.putText(img, "- " + line, (200, 360 + b * 150), cv2.FONT_HERSHEY_DUPLEX, 2.0, (30, 30, 30), 3, cv2.LINE_AA)
        cv2.putText(img, f"slide {k + 1}/{len(SLIDES)}", (W - 330, H - 50), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (120, 120, 120), 2)
        stamp(img, mt, "PRES")
        return img

    encode(OUT / "speaker.mp4", speaker_frame, int(total * FPS), spk_a)
    encode(OUT / "presentation.mp4", pres_frame, int((total + PRES_LEAD) * FPS), pres_a)
    for f in (aiff, speech, spk_a, pres_a):
        f.unlink()
    print("done:", OUT)


if __name__ == "__main__":
    main()
