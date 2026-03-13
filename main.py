"""
meeting-assistant · main.py
실행: uvicorn main:app --reload
"""
import asyncio, io, json, os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import List, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from docx import Document
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from pydantic import BaseModel

load_dotenv()
GLADIA_KEY = os.getenv("GLADIA_API_KEY", "")
GROQ_KEY   = os.getenv("GROQ_API_KEY",   "")

# ── HTTP 클라이언트 (앱 수명 동안 재사용) ─────────────
http: httpx.AsyncClient | None = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http
    http = httpx.AsyncClient(timeout=120)
    yield
    await http.aclose()

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ── 모델 ─────────────────────────────────────────────
class Todo(BaseModel):
    task:     str
    owner:    Optional[str] = None
    speaker:  Optional[int] = None
    priority: Optional[str] = "보통"


# ── 프롬프트 ──────────────────────────────────────────
_MINUTES = """아래 규칙을 반드시 따르세요:
1. 반드시 한국어로만 작성하세요. 외국 문자 사용 금지.
2. 불분명한 내용은 추측하지 말고 생략하세요.
3. 결정된 사항은 대화에서 명확히 결정된 것만 적으세요. 없으면 "없음".
4. 다음 형식을 그대로 사용하세요:

# 회의 요약
(2~3문장)

## 주요 논의사항
(간결하게)

## 결정된 사항
(구체적으로)

## 특이사항
(없으면 생략)"""

_TODO = """규칙:
- 대화에서 명확히 언급된 할 일만 추출하세요.
- owner: 담당자 이름이 언급된 경우만, 모르면 null.
- speaker: 담당 발화자 번호(정수), 모르면 null.
- 반드시 한국어로만 작성하세요. 외국 문자 절대 금지.

JSON 배열만 응답 (다른 텍스트 없이):
[{"task":"할 일","owner":"담당자 또는 null","speaker":0,"priority":"높음|보통|낮음"}]"""

_TOPICS = """당신은 회의 대화 분석 전문가입니다.

위 대화의 각 줄 맨 앞 숫자가 utterance 인덱스(0부터)입니다.
이 인덱스를 정확히 사용해 주제별로 분류하세요.

규칙:
1. title은 반드시 순수 한국어(한글)로만 작성. 한자·중국어·영어 절대 금지.
2. 대화의 실제 맥락 흐름을 기준으로 나누세요.
3. 주제 수: 최소 2개, 최대 8개.
4. title: 실제 논의 내용을 담은 명사형 한국어 (8자 이내).
5. start_idx·end_idx: 위 대화의 실제 줄 번호를 그대로 사용.
6. 전체 utterance를 빠짐없이 커버하고 중복·공백 없이.

주제 구분 기준:
- 새 안건으로 전환될 때 새 주제 시작
- 같은 주제의 세부 논의는 하나로 묶기
- 인사·잡담 → "회의 시작", 마무리 발언 → "마무리"

순수 JSON 배열만 응답 (``` 없이):
[{"title":"주제명","start_idx":0,"end_idx":5}]"""


# ── Gladia: 음성 인식 + 화자 분리 ───────────────────
async def transcribe(audio: bytes, n_speakers: int, lang: str) -> list:
    headers = {"x-gladia-key": GLADIA_KEY}
    lang_code = {"ko":"ko","ja":"ja","zh":"zh"}.get(lang, "en")

    # 1) 파일 업로드
    up = await http.post(
        "https://api.gladia.io/v2/upload",
        headers=headers,
        files={"audio": ("audio", audio, "audio/mpeg")},
    )
    up.raise_for_status()

    # 2) 전사 요청
    tr = await http.post(
        "https://api.gladia.io/v2/transcription",
        headers={**headers, "Content-Type": "application/json"},
        json={
            "audio_url": up.json()["audio_url"],
            "language": lang_code,
            "diarization": True,
            "diarization_config": {"number_of_speakers": n_speakers, "max_speakers": n_speakers},
        },
    )
    tr.raise_for_status()
    result_url = tr.json()["result_url"]

    # 3) 폴링
    for i in range(120):
        await asyncio.sleep(3)
        poll = await http.get(result_url, headers=headers)
        data = poll.json()
        print(f"[Gladia poll #{i}] status={data.get('status')}")
        if data["status"] == "done":
            utterances = data["result"]["transcription"]["utterances"]
            # speaker 필드 없는 경우 보정
            for i, u in enumerate(utterances):
                if "speaker" not in u:
                    u["speaker"] = 0
            return utterances
        if data["status"] in ("error", "failed"):
            raise HTTPException(500, f"음성 인식 실패: {data.get('error_code')}")
    raise HTTPException(500, "음성 인식 타임아웃")


# ── Groq: LLM 호출 ───────────────────────────────────
# 한국어 강제 system 메시지 — 회의록/일반 텍스트 응답용
SYSTEM_KO = (
    "You are a Korean meeting assistant. "
    "Write ALL text values in Korean (한글) only. "
    "Never use Chinese characters, Japanese, or English in text values. "
    "JSON keys stay in English; all values must be Korean."
)

GROQ_MODEL    = "llama-3.1-8b-instant"
GROQ_FALLBACK = "llama-3.3-70b-versatile"
MAX_CHARS = 8000

def _truncate(text: str) -> str:
    if len(text) <= MAX_CHARS:
        return text
    head = int(MAX_CHARS * 0.7)
    tail = MAX_CHARS - head
    return text[:head] + "\n\n...(중략)...\n\n" + text[-tail:]

async def groq(prompt: str, max_tokens: int = 2000, retries: int = 4) -> str:
    """Groq API 호출. 429 시 Retry-After 대기, 2회 이상 실패 시 경량 모델 폴백."""
    delay = 5.0
    for attempt in range(retries):
        model = GROQ_MODEL if attempt < 2 else GROQ_FALLBACK
        res = await http.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"},
            json={
                "model": model,
                "max_tokens": max_tokens,
                "messages": [
                    {"role": "system", "content": SYSTEM_KO},
                    {"role": "user",   "content": prompt},
                ],
            },
        )
        if res.status_code == 429:
            wait = float(res.headers.get("retry-after", delay))
            print(f"[Groq 429] model={model} retry_after={wait}s")
            if wait > 60:
                raise HTTPException(429, f"Groq API 사용량 초과 ({int(wait)}초 대기 필요). 잠시 후 다시 시도해주세요.")
            await asyncio.sleep(wait)
            delay = min(delay * 2, 60)
            continue
        res.raise_for_status()
        text = res.json()["choices"][0]["message"]["content"]
        return _strip_cjk(text)
    raise HTTPException(429, "Groq API 요청 한도 초과. 잠시 후 다시 시도해주세요.")


def _strip_cjk(text: str) -> str:
    import re
    return re.sub(r'[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+', '', text)


# ── 공통 분석: 회의록 → TO DO → 주제 ──
async def analyze(full_text: str, speaker_list: str, indexed_text: str) -> tuple:
    t  = _truncate(full_text)
    it = _truncate(indexed_text)
    print(f"[analyze] {len(full_text)}자 → truncated {len(t)}자")

    minutes_raw = await groq(f"다음은 회의 대화 내용입니다.\n\n{t}\n\n{_MINUTES}")
    await asyncio.sleep(1)
    todo_raw    = await groq(
        f"다음 회의 대화에서 액션 아이템을 추출하세요.\n\n{t}\n\n"
        f"발화자 번호: {speaker_list}\n\n{_TODO}",
        max_tokens=1000,
    )
    await asyncio.sleep(1)
    topics_raw  = await groq(
        f"다음 회의 대화입니다 (맨 앞 숫자가 utterance 인덱스).\n\n{it}\n\n{_TOPICS}",
        max_tokens=800,
    )
    return minutes_raw, _parse_todos(todo_raw), _parse_json(topics_raw, [])
def _parse_json(raw: str, fallback):
    try:
        return json.loads(raw.replace("```json","").replace("```","").strip())
    except Exception:
        return fallback

def _parse_todos(raw: str) -> List[Todo]:
    try:
        return [Todo(**t) for t in _parse_json(raw, [])]
    except Exception:
        return []


# ── Word 생성 ─────────────────────────────────────────
def build_docx(minutes: str, todos: List[Todo], transcript: str = "") -> bytes:
    doc = Document()

    # 제목
    title = doc.add_heading("회의록", 0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    date = doc.add_paragraph(datetime.now().strftime("%Y년 %m월 %d일"))
    date.alignment = WD_ALIGN_PARAGRAPH.CENTER
    date.runs[0].font.size = Pt(10)
    date.runs[0].font.color.rgb = RGBColor(0x66, 0x66, 0x88)
    doc.add_paragraph()

    if minutes:
        doc.add_heading("📋 회의록", 1)
        for line in minutes.split("\n"):
            if line.startswith(("## ","# ")):
                doc.add_heading(line.lstrip("# "), 2)
            elif line.strip():
                doc.add_paragraph(line)

    if todos:
        doc.add_page_break()
        doc.add_heading("✅ TO DO", 1)
        tbl = doc.add_table(rows=1, cols=4)
        tbl.style = "Table Grid"
        for i, h in enumerate(["할 일","담당자","우선순위","완료"]):
            c = tbl.rows[0].cells[i]
            c.text = h; c.paragraphs[0].runs[0].font.bold = True
        for t in todos:
            r = tbl.add_row().cells
            r[0].text = t.task; r[1].text = t.owner or "-"
            r[2].text = t.priority or "보통"; r[3].text = "☐"

    if transcript:
        doc.add_page_break()
        doc.add_heading("📝 전체 대화", 1)
        for line in transcript.split("\n"):
            if line.strip():
                doc.add_paragraph(line)

    buf = io.BytesIO()
    doc.save(buf); buf.seek(0)
    return buf.read()


# ── 엔드포인트 ────────────────────────────────────────
def _check_keys():
    if not GLADIA_KEY or not GROQ_KEY:
        raise HTTPException(500, ".env 파일에 API 키를 설정해주세요.")


@app.post("/analyze")
async def analyze_endpoint(
        file: UploadFile = File(...),
        speaker_count: int = Form(4),
        language: str = Form("ko"),
):
    _check_keys()
    audio = await file.read()
    utterances = await transcribe(audio, speaker_count, language)

    full_text    = "\n".join(f"[발화자 {u['speaker']}] {u['text']}" for u in utterances)
    indexed_text = "\n".join(f"{i} [발화자 {u['speaker']}] {u['text']}" for i, u in enumerate(utterances))
    speaker_list = ", ".join(str(s) for s in sorted({u["speaker"] for u in utterances}))

    minutes, todos, topics = await analyze(full_text, speaker_list, indexed_text)
    return {
        "utterances": utterances,
        "full_text":  full_text,
        "minutes":    minutes,
        "todos":      [t.dict() for t in todos],
        "topics":     topics,
    }


@app.post("/regenerate")
async def regenerate_endpoint(full_text: str = Form(...), speaker_count: int = Form(4)):
    _check_keys()
    lines = [l for l in full_text.split("\n") if l.strip()]
    indexed_text = "\n".join(f"{i} {l}" for i, l in enumerate(lines))
    speaker_list = ", ".join(str(s) for s in sorted({
        int(l.split("]")[0].replace("[발화자 ",""))
        for l in lines if l.startswith("[발화자 ")
    }))
    minutes, todos, topics = await analyze(full_text, speaker_list, indexed_text)
    return {"minutes": minutes, "todos": [t.dict() for t in todos], "topics": topics}


@app.post("/generate-docx")
async def docx_endpoint(
        minutes:    str = Form(""),
        todos_json: str = Form("[]"),
        transcript: str = Form(""),
):
    todos = _parse_todos(todos_json)
    return StreamingResponse(
        io.BytesIO(build_docx(minutes, todos, transcript)),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": "attachment; filename=meeting_minutes.docx"},
    )


@app.get("/")
def root():
    return {"status": "meeting-assistant running"}