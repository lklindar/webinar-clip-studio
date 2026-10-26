"""Transcript utilities: sentences, word ranges, topics."""
import re
from collections import Counter

STOP = set("""a an the and or but if then so of to in on at for with from by as is are was were be been being it its
this that these those i you he she we they me him her us them my your our their his hers what which who whom whose
when where why how all any both each few more most other some such no nor not only own same than too very can will
just do does did doing have has had having would could should may might must shall about above after again against
before below between during into through under until up down out off over once here there s t don now ll re ve m d
im it's i'm you're we're they're that's there's let's okay ok yeah um uh like really actually also get got go going
know think one two three thing things lot kind sort way say said see well right want make also much many even still
because thank thanks today everyone people time something anything everything""".split())


def build_sentences(words: list[dict], max_words=40, gap=1.2) -> list[dict]:
    sents, cur = [], []

    def flush():
        if cur:
            sents.append({"id": len(sents), "start": cur[0]["start"], "end": cur[-1]["end"],
                          "w0": cur[0]["i"], "w1": cur[-1]["i"], "text": " ".join(w["text"] for w in cur)})
            cur.clear()

    for i, w in enumerate(words):
        if cur and w["start"] - cur[-1]["end"] > gap:
            flush()
        cur.append({**w, "i": i})
        t = w["text"]
        if re.search(r"[.!?…][\"')\]]*$", t):
            flush()
        elif len(cur) >= max_words and re.search(r"[,;:]$", t):
            flush()
        elif len(cur) >= max_words * 1.6:
            flush()
    flush()
    return sents


def words_in_range(words, start, end):
    return [w for w in words if w["end"] > start + 0.02 and w["start"] < end - 0.02]


def text_in_range(words, start, end):
    return " ".join(w["text"] for w in words_in_range(words, start, end))


def keywords(text: str, n=3) -> list[str]:
    toks = re.findall(r"[A-Za-z][A-Za-z'-]{2,}", text.lower())
    c = Counter(t for t in toks if t not in STOP and len(t) > 3)
    return [w for w, _ in c.most_common(n)]


def fmt_time(t: float) -> str:
    t = max(0, t)
    h, m, s = int(t // 3600), int(t % 3600 // 60), t % 60
    return f"{h}:{m:02d}:{s:04.1f}" if h else f"{m}:{s:04.1f}"
