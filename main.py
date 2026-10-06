from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from groq import Groq

from pathlib import Path
import os
import shutil
import subprocess
import uuid
import json
import re



# PATHS#

BASE_DIR = Path(__file__).resolve().parent
ENV_FILE = BASE_DIR / ".env"
UPLOAD_DIR = BASE_DIR / "uploads"
AUDIO_DIR = BASE_DIR / "audio"
FRONTEND_DIR = BASE_DIR

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)


# ENVIRONMENT & GROQ CONFIGURATION# 

load_dotenv(dotenv_path=ENV_FILE, override=True)
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

CHAT_MODELS = [
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "qwen/qwen3.6-27b",
    "groq/compound-mini"
]

TRANSCRIPTION_MODELS = [
    "whisper-large-v3-turbo",
    "whisper-large-v3"
]

def is_valid_groq_key(key: str | None) -> bool:
    if not key:
        return False
    key = key.strip()
    if not key:
        return False
    if key.lower() in {
        "your_actual_api_key",
        "your-api-key-here",
        "changeme",
        "sk-placeholder",
        "sk-xxxx"
    }:
        return False
    return key.startswith("gsk_") and len(key) > 20

client = None

if is_valid_groq_key(GROQ_API_KEY):
    print("=" * 60)
    print("GROQ API KEY FOUND")
    print("KEY:", GROQ_API_KEY[:7] + "..." + GROQ_API_KEY[-4:])
    print("=" * 60)
    try:
        client = Groq(api_key=GROQ_API_KEY)
        print("GROQ CLIENT READY")
    except Exception as e:
        print("GROQ CLIENT ERROR:", repr(e))
else:
    print("=" * 60)
    print("GROQ API KEY NOT FOUND / INVALID")
    print("Create this file:", ENV_FILE)
    print("Add: GROQ_API_KEY=gsk_your_key_here")
    print("=" * 60)


def call_groq_chat(messages, temperature=0.2, response_format=None, max_tokens=None):
    """Executes chat completion with fallback across available models."""
    if client is None:
        raise Exception("Groq API client is not configured.")

    last_error = None
    for model_name in CHAT_MODELS:
        try:
            kwargs = {
                "model": model_name,
                "messages": messages,
                "temperature": temperature
            }
            if response_format:
                kwargs["response_format"] = response_format
            if max_tokens:
                kwargs["max_tokens"] = max_tokens

            response = client.chat.completions.create(**kwargs)
            content = response.choices[0].message.content or ""
            return content.strip(), model_name
        except Exception as e:
            last_error = e
            print(f"[Groq Chat] Model {model_name} failed: {e}. Trying next model...")
            continue

    raise Exception(f"All Groq models failed. Last error: {str(last_error)}")



# FASTAPI APP# 

app = FastAPI(
    title="AI Lecture Intelligence System",
    version="4.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)

# STATE MANAGEMENT# 

current_transcript: str = ""
current_filename: str = ""
current_stored_filename: str = ""

def clean_lecture_name(stored_name: str) -> str:
    """Extracts human-readable display name from stored name by removing UUID prefix."""
    parts = stored_name.split("_", 1)
    if len(parts) == 2 and len(parts[0]) == 8:
        try:
            int(parts[0], 16)
            return parts[1]
        except ValueError:
            pass
    return stored_name


def auto_load_latest_lecture():
    """On backend startup, load the latest uploaded lecture with a transcript."""
    global current_transcript, current_filename, current_stored_filename
    try:
        if not UPLOAD_DIR.exists():
            return
        allowed_extensions = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".mp3", ".wav", ".m4a"}
        files = sorted(
            [f for f in UPLOAD_DIR.iterdir() if f.is_file() and f.suffix.lower() in allowed_extensions and not f.name.endswith("_transcript.txt")],
            key=lambda p: p.stat().st_mtime,
            reverse=True
        )
        for file_path in files:
            transcript_file = UPLOAD_DIR / f"{file_path.stem}_transcript.txt"
            if transcript_file.exists() and transcript_file.stat().st_size > 0:
                with open(transcript_file, "r", encoding="utf-8") as f:
                    current_transcript = f.read().strip()
                current_stored_filename = file_path.name
                current_filename = clean_lecture_name(file_path.name)
                print(f"Auto-loaded active lecture: {current_filename} ({len(current_transcript)} chars)")
                break
    except Exception as e:
        print("Auto-load lecture error:", repr(e))


auto_load_latest_lecture()


# REQUEST MODELS#

class QuestionRequest(BaseModel):
    question: str

class SelectLectureRequest(BaseModel):
    stored_name: str | None = None
    filename: str | None = None

def error_response(message: str, status_code: int = 200):
    return JSONResponse(
        status_code=status_code,
        content={"success": False, "message": message}
    )

# API ROUTES#

@app.get("/health")
def health():
    return {
        "success": True,
        "fastapi": "running",
        "groq_configured": client is not None,
        "transcript_available": bool(current_transcript),
        "current_lecture": current_filename,
        "current_stored_filename": current_stored_filename,
        "transcript_length": len(current_transcript)
    }


@app.get("/test-ai")
def test_ai():
    if client is None:
        return error_response("Groq API is not configured. Check backend/.env")
    try:
        answer, model_used = call_groq_chat(
            messages=[{"role": "user", "content": "Say exactly: AI CONNECTION WORKING"}],
            temperature=0
        )
        return {"success": True, "answer": answer, "model": model_used}
    except Exception as e:
        print("GROQ CHAT TEST ERROR:", repr(e))
        return error_response(f"Groq error: {str(e)}")


def check_ffmpeg():
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        return result.returncode == 0
    except Exception:
        return shutil.which("ffmpeg") is not None


def extract_audio(video_path: Path, audio_path: Path):
    print("=" * 60)
    print("EXTRACTING AUDIO")
    print("VIDEO:", video_path.name)
    print("=" * 60)

    if not check_ffmpeg():
        raise Exception("FFmpeg is not installed or not in PATH.")

    command = [
        "ffmpeg",
        "-y",
        "-i", str(video_path),
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-codec:a", "libmp3lame",
        "-b:a", "32k",
        str(audio_path)
    ]

    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )

    if result.returncode != 0:
        print("FFmpeg stderr:", result.stderr)
        raise Exception("FFmpeg failed to extract audio.")

    if not audio_path.exists() or audio_path.stat().st_size == 0:
        raise Exception("Extracted audio file is empty or missing.")

    print(f"AUDIO CREATED: {audio_path} ({audio_path.stat().st_size} bytes)")


def transcribe_audio(audio_path: Path) -> str:
    if client is None:
        raise Exception("Groq API client is not configured.")

    if not audio_path.exists() or audio_path.stat().st_size == 0:
        raise Exception("Audio file is missing or empty.")

    file_size = audio_path.stat().st_size
    print(f"Starting Groq transcription: {audio_path.name} ({file_size} bytes)")

    last_error = None
    for model_name in TRANSCRIPTION_MODELS:
        try:
            with open(audio_path, "rb") as audio_file:
                result = client.audio.transcriptions.create(
                    model=model_name,
                    file=(audio_path.name, audio_file, "audio/mpeg"),
                    response_format="json",
                    temperature=0
                )
            transcript = getattr(result, "text", "")
            transcript = (transcript or "").strip()
            if transcript:
                print(f"Transcription complete using {model_name} ({len(transcript)} chars)")
                return transcript
        except Exception as e:
            last_error = e
            print(f"[Groq Whisper] Model {model_name} failed: {e}. Trying fallback...")
            continue

    raise Exception(f"Groq transcription failed: {str(last_error)}")


@app.post("/upload")
async def upload_lecture(file: UploadFile = File(...)):
    global current_transcript, current_filename, current_stored_filename

    print()
    print("=" * 70)
    print("NEW LECTURE UPLOAD")
    print("=" * 70)

    try:
        if not file.filename:
            return error_response("No file selected.")

        original_name = Path(file.filename).name
        extension = Path(original_name).suffix.lower()

        allowed_extensions = {
            ".mp4", ".mov", ".avi", ".mkv", ".webm",
            ".mp3", ".wav", ".m4a"
        }

        if extension not in allowed_extensions:
            return error_response(
                "Unsupported file format. Use MP4, MOV, AVI, MKV, WEBM, MP3, WAV or M4A."
            )

        # Clear old active state
        current_transcript = ""
        current_filename = ""
        current_stored_filename = ""

        # Unique name
        unique_id = uuid.uuid4().hex[:8]
        # Sanitize filename
        safe_original_name = re.sub(r'[^a-zA-Z0-9._-]', '_', original_name)
        saved_name = f"{unique_id}_{safe_original_name}"
        lecture_path = UPLOAD_DIR / saved_name

        print("Saving lecture:", lecture_path)
        with open(lecture_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        if lecture_path.stat().st_size == 0:
            lecture_path.unlink(missing_ok=True)
            return error_response("Uploaded file is empty.")

        current_filename = original_name
        current_stored_filename = saved_name

        # Prepare audio path
        audio_name = f"{Path(saved_name).stem}.mp3"
        audio_path = AUDIO_DIR / audio_name

        # Extract / convert audio
        try:
            if extension == ".mp3":
                shutil.copyfile(lecture_path, audio_path)
            else:
                extract_audio(lecture_path, audio_path)
        except Exception as e:
            print("Audio extraction failed:", repr(e))
            return {
                "success": False,
                "message": f"Lecture uploaded but audio extraction failed: {str(e)}",
                "filename": original_name,
                "stored_name": saved_name
            }

        # Transcribe audio
        try:
            transcript = transcribe_audio(audio_path)
        except Exception as e:
            print("Transcription failed:", repr(e))
            return {
                "success": True,
                "message": "Lecture uploaded, but transcription failed.",
                "filename": original_name,
                "stored_name": saved_name,
                "transcript": "",
                "transcript_length": 0,
                "transcription_error": str(e)
            }

        current_transcript = transcript

        # Save transcript file
        transcript_file = UPLOAD_DIR / f"{Path(saved_name).stem}_transcript.txt"
        with open(transcript_file, "w", encoding="utf-8") as f:
            f.write(transcript)

        print(f"Lecture Ready: {original_name} ({len(transcript)} chars, {len(transcript.split())} words)")

        return {
            "success": True,
            "message": "Lecture uploaded and transcribed successfully.",
            "filename": original_name,
            "stored_name": saved_name,
            "transcript": transcript,
            "transcript_length": len(transcript),
            "word_count": len(transcript.split())
        }

    except Exception as e:
        print("UPLOAD ERROR:", repr(e))
        return error_response(str(e))


@app.get("/lectures")
def list_lectures():
    try:
        lectures = []
        if not UPLOAD_DIR.exists():
            return {"success": True, "lectures": []}

        allowed_extensions = {
            ".mp4", ".mov", ".avi", ".mkv", ".webm",
            ".mp3", ".wav", ".m4a"
        }

        files = sorted(
            UPLOAD_DIR.iterdir(),
            key=lambda p: p.stat().st_mtime,
            reverse=True
        )

        for file_path in files:
            if not file_path.is_file():
                continue
            if file_path.suffix.lower() not in allowed_extensions:
                continue

            name = file_path.name
            if name.endswith("_transcript.txt"):
                continue

            display_name = clean_lecture_name(name)
            transcript_file = UPLOAD_DIR / f"{file_path.stem}_transcript.txt"
            has_transcript = transcript_file.exists() and transcript_file.stat().st_size > 0
            
            transcript_preview = ""
            word_count = 0
            if has_transcript:
                try:
                    with open(transcript_file, "r", encoding="utf-8") as f:
                        content = f.read()
                        word_count = len(content.split())
                        transcript_preview = content[:200]
                except Exception:
                    pass

            lectures.append({
                "filename": display_name,
                "stored_name": name,
                "has_transcript": has_transcript,
                "word_count": word_count,
                "preview": transcript_preview,
                "is_active": (name == current_stored_filename)
            })

        return {"success": True, "lectures": lectures}

    except Exception as e:
        print("LECTURES ERROR:", repr(e))
        return {"success": False, "message": str(e), "lectures": []}


@app.post("/select-lecture")
def select_lecture(data: SelectLectureRequest):
    """Sets a specific lecture as the current active lecture and loads its transcript."""
    global current_transcript, current_filename, current_stored_filename

    stored_name = data.stored_name
    filename = data.filename

    if not stored_name and not filename:
        return error_response("Please provide stored_name or filename.")

    # Find the target file in UPLOAD_DIR
    target_file = None
    if stored_name:
        p = UPLOAD_DIR / stored_name
        if p.exists() and p.is_file():
            target_file = p

    if not target_file and filename:
        for f in UPLOAD_DIR.iterdir():
            if f.is_file() and clean_lecture_name(f.name) == filename and not f.name.endswith("_transcript.txt"):
                target_file = f
                break

    if not target_file:
        return error_response("Lecture file not found on server.")

    stored_name = target_file.name
    display_name = clean_lecture_name(stored_name)

    transcript_file = UPLOAD_DIR / f"{target_file.stem}_transcript.txt"
    transcript_text = ""
    if transcript_file.exists():
        with open(transcript_file, "r", encoding="utf-8") as f:
            transcript_text = f.read().strip()

    current_stored_filename = stored_name
    current_filename = display_name
    current_transcript = transcript_text

    print(f"Selected Lecture: {display_name} (Transcript len: {len(transcript_text)})")

    return {
        "success": True,
        "message": f"Lecture '{display_name}' selected.",
        "filename": display_name,
        "stored_name": stored_name,
        "transcript": transcript_text,
        "transcript_length": len(transcript_text),
        "word_count": len(transcript_text.split())
    }


@app.get("/lecture/{stored_name}")
def get_lecture(stored_name: str):
    target_file = UPLOAD_DIR / stored_name
    if not target_file.exists() or not target_file.is_file():
        return error_response("Lecture not found.", status_code=404)

    display_name = clean_lecture_name(stored_name)
    transcript_file = UPLOAD_DIR / f"{target_file.stem}_transcript.txt"
    transcript_text = ""
    if transcript_file.exists():
        with open(transcript_file, "r", encoding="utf-8") as f:
            transcript_text = f.read().strip()

    return {
        "success": True,
        "filename": display_name,
        "stored_name": stored_name,
        "transcript": transcript_text,
        "transcript_length": len(transcript_text)
    }


@app.delete("/lectures/{stored_name}")
def delete_lecture_file(stored_name: str):
    global current_transcript, current_filename, current_stored_filename

    target_file = UPLOAD_DIR / stored_name
    transcript_file = UPLOAD_DIR / f"{Path(stored_name).stem}_transcript.txt"
    audio_file = AUDIO_DIR / f"{Path(stored_name).stem}.mp3"

    deleted_anything = False

    if target_file.exists():
        target_file.unlink(missing_ok=True)
        deleted_anything = True

    if transcript_file.exists():
        transcript_file.unlink(missing_ok=True)
        deleted_anything = True

    if audio_file.exists():
        audio_file.unlink(missing_ok=True)
        deleted_anything = True

    if current_stored_filename == stored_name:
        current_transcript = ""
        current_filename = ""
        current_stored_filename = ""

    if not deleted_anything:
        return error_response("Lecture file not found.", status_code=404)

    return {
        "success": True,
        "message": f"Lecture '{clean_lecture_name(stored_name)}' deleted successfully."
    }


@app.get("/transcript")
def get_transcript():
    if not current_transcript:
        return {
            "success": False,
            "message": "Transcript unavailable. Please upload or select a lecture first."
        }

    return {
        "success": True,
        "transcript": current_transcript,
        "filename": current_filename,
        "stored_name": current_stored_filename,
        "transcript_length": len(current_transcript),
        "word_count": len(current_transcript.split())
    }


@app.post("/notes")
def generate_notes():
    if not current_transcript:
        return error_response("Transcript unavailable. Please upload or select a lecture first.")

    if client is None:
        return error_response("Groq API is not configured.")

    try:
        prompt = f"""You are an expert B.Tech academic assistant.
Create complete and accurate study notes from the lecture transcript below.

IMPORTANT:
Use ONLY information present in the transcript.
Do not invent topics or facts.

LECTURE TRANSCRIPT:
--------------------
{current_transcript[:25000]}
--------------------

Create the following:

1. Lecture Summary
2. Important Topics
3. Key Concepts
4. Important Definitions
5. Key Points
6. Examples mentioned in the lecture
7. Exam Preparation Points
8. Five Important Questions & Answers
9. Quick Revision Summary

Rules:
- Use simple and precise language.
- Use clear markdown headings (##, ###) and structured bullet points.
- Make the notes comprehensive and directly useful for engineering students.
- Do not add information that is not supported by the transcript.
"""
        notes, model_used = call_groq_chat(
            messages=[
                {"role": "system", "content": "You are an expert academic note-making assistant for university students."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.2
        )

        if not notes:
            return error_response("AI returned empty notes.")

        return {
            "success": True,
            "notes": notes,
            "filename": current_filename,
            "model": model_used
        }

    except Exception as e:
        print("NOTES ERROR:", repr(e))
        return error_response(f"Failed to generate notes: {str(e)}")


@app.post("/ask")
def ask_ai(data: QuestionRequest):
    question = data.question.strip()

    if not question:
        return error_response("Question cannot be empty.")

    if client is None:
        return error_response("Groq API is not configured.")

    if not current_transcript:
        return error_response(
            "No lecture transcript is available. Please upload a lecture or select one from My Lectures."
        )

    try:
        prompt = f"""You are an AI Lecture Assistant for university students.
Answer the student's question accurately using the lecture transcript.

LECTURE TRANSCRIPT:
--------------------
{current_transcript[:25000]}
--------------------

STUDENT QUESTION:
--------------------
{question}
--------------------

Rules:
1. Answer using the lecture transcript.
2. Use clear, helpful, and concise language.
3. Give a direct answer first, followed by explanations or bullet points if needed.
4. If relevant, mention examples or details discussed in the lecture.
5. Do NOT hallucinate or invent information not in the lecture.
6. If the answer is not covered in the transcript, say clearly: "This topic was not covered in the uploaded lecture."
"""
        answer, model_used = call_groq_chat(
            messages=[
                {"role": "system", "content": "You are a helpful academic AI lecture assistant."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.2
        )

        if not answer:
            return error_response("AI returned an empty answer.")

        return {
            "success": True,
            "answer": answer,
            "filename": current_filename,
            "model": model_used
        }

    except Exception as e:
        print("ASK ERROR:", repr(e))
        return error_response(f"Failed to answer question: {str(e)}")


@app.post("/quiz")
def generate_quiz():
    """Generates 5 multiple choice questions based on the active lecture transcript."""
    if not current_transcript:
        return error_response("No lecture transcript is available. Please upload or select a lecture first.")

    if client is None:
        return error_response("Groq API is not configured.")

    try:
        prompt = f"""You are an expert university professor and exam creator.
Create 5 multiple choice questions based on the following lecture transcript. If the transcript is brief or introductory, formulate foundational questions relating to the subject or topic referenced ({current_filename}).

LECTURE TRANSCRIPT:
--------------------
{current_transcript[:20000]}
--------------------

Return a JSON object with this EXACT structure:
{{
  "title": "Quiz on {current_filename or 'Lecture'}",
  "questions": [
    {{
      "id": 1,
      "question": "Question text here?",
      "options": [
        "Option A text",
        "Option B text",
        "Option C text",
        "Option D text"
      ],
      "correct_index": 0,
      "explanation": "Clear explanation why this option is correct."
    }}
  ]
}}

Rules:
- You MUST ALWAYS return a valid JSON object matching the schema with 5 questions.
- Generate exactly 5 questions.
- Provide exactly 4 options per question.
- 'correct_index' must be an integer from 0 to 3 (0 for first option, 1 for second, 2 for third, 3 for fourth).
- Include clear explanations for why the correct answer is right.
- Ensure questions test key concepts, definitions, and applications.
"""
        raw_json, model_used = call_groq_chat(
            messages=[
                {"role": "system", "content": "You are an expert exam generator. You ALWAYS output valid JSON matching the specified schema with 5 questions."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.2,
            response_format={"type": "json_object"}
        )

        cleaned_json = raw_json.strip()
        if cleaned_json.startswith("```"):
            cleaned_json = re.sub(r"^```(?:json)?\s*", "", cleaned_json)
            cleaned_json = re.sub(r"\s*```$", "", cleaned_json)

        quiz_data = json.loads(cleaned_json)
        questions = quiz_data.get("questions", [])

        if not questions:
            return error_response("Failed to generate quiz questions.")

        return {
            "success": True,
            "title": quiz_data.get("title", f"Quiz: {current_filename}"),
            "filename": current_filename,
            "questions": questions,
            "model": model_used
        }

    except Exception as e:
        print("QUIZ ERROR:", repr(e))
        return error_response(f"Failed to generate quiz: {str(e)}")


@app.delete("/clear")
def clear_lecture():
    global current_transcript, current_filename, current_stored_filename

    current_transcript = ""
    current_filename = ""
    current_stored_filename = ""

    return {
        "success": True,
        "message": "Current lecture state cleared."
    }

# FRONTEND STATIC FILES & FALLBACK# 

@app.get("/")
def home():
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return {
        "success": True,
        "message": "AI Lecture Intelligence API is running"
    }

if FRONTEND_DIR.exists():
    app.mount(
        "/",
        StaticFiles(
            directory=str(FRONTEND_DIR),
            html=True
        ),
        name="frontend"
    )

# RUN SERVER# 

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8000
    )
