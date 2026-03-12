# meeting-assistant

회의 녹음 파일을 업로드하면 AI가 발화자를 분리하고 회의록 + TO DO를 자동 생성합니다.

## 폴더 구조

```
meeting-assistant/
├── index.html        ← 프론트엔드
├── styles.css        ← 스타일
├── app.js            ← 프론트엔드 로직
├── main.py           ← FastAPI 백엔드
├── requirements.txt  ← Python 패키지
├── .env              ← API 키 (외부 공유 금지)
└── README.md
```

## 필요한 API 키

| 서비스 | 용도 | 가입 주소 |
|--------|------|-----------|
| Gladia | 화자 분리 + 음성인식 (월 10시간 무료) | https://www.gladia.io |
| Groq   | 회의록 / TO DO / 주제 생성 (무료) | https://console.groq.com |

`.env` 파일:
```
GLADIA_API_KEY=여기에_Gladia_키_입력
GROQ_API_KEY=여기에_Groq_키_입력
```

## 설치 및 실행

```bash
# 1. 패키지 설치
python -m pip install -r requirements.txt

# 2. 백엔드 실행
uvicorn main:app --reload

# 3. index.html을 브라우저에서 열기
```

### IntelliJ Run Configuration
- Module: `uvicorn` / Parameters: `main:app --reload`
- Working directory: 프로젝트 폴더

---

## 주요 기능

### 분석 (AI 자동 생성)
- **화자 분리 + 음성인식** — Gladia API. 발화자별 타임스탬프 포함
- **회의록** — Groq AI (llama-3.3-70b)로 핵심 요약 + 결정사항 정리
- **TO DO** — 발화자별 액션 아이템 자동 추출, 우선순위/담당자 포함
- **대화 주제 분류** — 회의 흐름을 시간순 주제로 자동 분류 (우측 네비게이터)
- 회의록 / TO DO / 주제 분류는 **병렬 생성**으로 시간 절약

### 발화자 관리
- **이름 변경** — 발화자 목록 카드에서 직접 클릭하여 수정. 대화, TO DO에 즉시 반영
- **병합** — 같은 사람으로 인식된 발화자들을 하나로 합치기 (⚙ 관리)
- **추가** — 새 발화자 추가 후 대화 내용에서 우클릭으로 발화자 지정 (⚙ 관리)
- **미리듣기** — 발화자 카드의 ▶ 버튼: 타인과 겹치지 않는 가장 뚜렷한 구간을 독립 오디오로 재생 (메인 플레이어 영향 없음)

### 대화 편집
- **인라인 편집** — 모든 텍스트를 클릭해서 직접 수정
- **발화자 변경** — 발화 우클릭 → 원하는 발화자로 재지정
- **발화 분리** — 발화 우클릭 → 여기서 새 그룹 시작
- **재생성** — 수정된 대화를 기반으로 회의록 + TO DO 재생성

### 오디오
- **인라인 플레이어** — 결과 화면 상단 고정
- **플로팅 플레이어** — 스크롤 시 우상단에 등장, hover로 확장
- **발화 재생** — 각 발화의 ▶ 버튼으로 해당 시점부터 재생

### 네비게이션
- **주제 네비게이터** — 화면 우측 고정. 기본은 주제 수만큼 라인 점, hover 시 주제 목록 표시. 클릭 시 해당 대화로 이동
- **FAB 버튼** — 우하단: 재생성(대화탭), 맨 위로

### 내보내기
- 회의록: Markdown / Word(.docx)
- TO DO: Markdown / Word(.docx)

## 지원 파일 형식

MP3 · MP4 · WAV · M4A · FLAC · OGG · WEBM