
// AI LECTURE INTELLIGENCE SYSTEM - FRONTEND SCRIPT//

const API_URL = window.location.protocol.startsWith("http")
    ? window.location.origin
    : "http://127.0.0.1:8000";

if (window.location.protocol === "file:") {
    console.error("Cannot connect to FastAPI from file:// protocol. Open http://127.0.0.1:8000 in your browser.");

    const banner = document.createElement("div");
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;background:#fee2e2;color:#b91c1c;padding:14px;text-align:center;z-index:99999;font-family:Arial,sans-serif;font-weight:bold;";
    banner.innerHTML = "&#9888; You opened this page from your file system. Open <strong>http://127.0.0.1:8000</strong> in your browser instead.";
    document.body.prepend(banner);
}


// STATE MANAGEMENT//

const STATS_KEY = "lectureAI_stats_v2";
const NOTES_CACHE_KEY = "lectureAI_notes_cache";

let activeLecture = {
    filename: "",
    stored_name: "",
    transcript: "",
    notes: ""
};

let serverLectures = [];
let isUploading = false;
let isGeneratingNotes = false;
let isGeneratingQuiz = false;

let stats = {
    totalLectures: 0,
    notesCount: 0,
    quizCount: 0,
    questionCount: 0
};

let currentQuiz = null;
let quizScore = 0;
let quizAnsweredCount = 0;

// Load persisted stats
function loadSavedStats() {
    try {
        const raw = localStorage.getItem(STATS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            stats = { ...stats, ...parsed };
        }
    } catch (e) {
        console.error("Stats load error:", e);
    }
}

function saveStats() {
    try {
        localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch (e) {
        console.error("Stats save error:", e);
    }
}


// DOM ELEMENTS//
const navLinks = document.querySelectorAll(".nav-link");
const pages = document.querySelectorAll(".page");
const pageTitle = document.getElementById("pageTitle");
const menuBtn = document.getElementById("menuBtn");
const sidebar = document.querySelector(".sidebar");

const fileInput = document.getElementById("fileInput");
const uploadBox = document.getElementById("uploadBox");
const askBtn = document.getElementById("askBtn");
const questionInput = document.getElementById("questionInput");
const clearChatBtn = document.getElementById("clearChatBtn");
const lectureSearch = document.getElementById("lectureSearch");
const lectureUploadBtn = document.getElementById("lectureUploadBtn");
const generateQuizBtn = document.getElementById("generateQuizBtn");
const startQuizBtn = document.getElementById("startQuizBtn");


// TOAST NOTIFICATION// 

function showToast(message, duration = 3000) {
    const existing = document.querySelector(".toast-msg");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "toast-msg";
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.3s ease";
        setTimeout(() => toast.remove(), 300);
    }, duration);
}


// PAGE NAVIGATION// 

function showPage(pageName) {
    pages.forEach(p => p.classList.remove("active-page"));
    navLinks.forEach(l => l.classList.remove("active"));

    const targetPage = document.getElementById(pageName);
    if (targetPage) {
        targetPage.classList.add("active-page");
    }

    const targetLink = document.querySelector(`[data-page="${pageName}"]`);
    if (targetLink) {
        targetLink.classList.add("active");
    }

    const titles = {
        dashboard: "Dashboard",
        lectures: "My Lectures",
        upload: "Upload Lecture",
        quiz: "AI Quiz",
        ask: "Ask My Lecture",
        analytics: "Analytics"
    };

    if (pageTitle) {
        pageTitle.textContent = titles[pageName] || "Dashboard";
    }

    if (sidebar) {
        sidebar.classList.remove("show");
    }

    window.scrollTo({ top: 0, behavior: "smooth" });

    // Refresh views if needed
    if (pageName === "lectures") {
        renderLecturesList();
    } else if (pageName === "dashboard") {
        renderRecentLectures();
    } else if (pageName === "quiz") {
        updateQuizPrompt();
    }
}

window.showPage = showPage;

navLinks.forEach(link => {
    link.addEventListener("click", function (e) {
        e.preventDefault();
        showPage(this.dataset.page);
    });
});

if (menuBtn && sidebar) {
    menuBtn.addEventListener("click", function (e) {
        e.preventDefault();
        sidebar.classList.toggle("show");
    });
}

if (lectureUploadBtn) {
    lectureUploadBtn.addEventListener("click", () => showPage("upload"));
}


// ACTIVE LECTURE & UI SYNCHRONIZATION// 

function updateActiveLectureUI() {
    const headerName = document.getElementById("headerLectureName");
    const chatName = document.getElementById("chatLectureName");
    const analyticsActive = document.getElementById("analyticsActiveLecture");

    const displayName = activeLecture.filename || "No lecture active";

    if (headerName) {
        headerName.textContent = displayName.length > 28
            ? displayName.substring(0, 25) + "..."
            : displayName;
        headerName.title = displayName;
    }

    if (chatName) {
        chatName.textContent = displayName;
    }

    if (analyticsActive) {
        analyticsActive.textContent = displayName;
    }

    updateQuizPrompt();
}

function updateStatistics() {
    const totalLecturesEl = document.getElementById("totalLectures");
    const notesCountEl = document.getElementById("notesCount");
    const quizCountEl = document.getElementById("quizCount");
    const questionCountEl = document.getElementById("questionCount");

    const analyticsLectures = document.getElementById("analyticsLectures");
    const analyticsNotes = document.getElementById("analyticsNotes");
    const analyticsQuestions = document.getElementById("analyticsQuestions");
    const analyticsQuizzes = document.getElementById("analyticsQuizzes");

    stats.totalLectures = serverLectures.length;
    saveStats();

    if (totalLecturesEl) totalLecturesEl.textContent = stats.totalLectures;
    if (notesCountEl) notesCountEl.textContent = stats.notesCount;
    if (quizCountEl) quizCountEl.textContent = stats.quizCount;
    if (questionCountEl) questionCountEl.textContent = stats.questionCount;

    if (analyticsLectures) analyticsLectures.textContent = stats.totalLectures;
    if (analyticsNotes) analyticsNotes.textContent = stats.notesCount;
    if (analyticsQuestions) analyticsQuestions.textContent = stats.questionCount;
    if (analyticsQuizzes) analyticsQuizzes.textContent = stats.quizCount;
}


// BACKEND API CALLS// 

async function checkFastAPI() {
    try {
        const res = await fetch(`${API_URL}/health`, { method: "GET", cache: "no-store" });
        if (!res.ok) return false;
        const data = await res.json();
        return data.success === true;
    } catch {
        return false;
    }
}

async function loadServerLectures() {
    try {
        const res = await fetch(`${API_URL}/lectures`, { method: "GET", cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.success) {
            serverLectures = data.lectures || [];
            updateStatistics();
            renderLecturesList();
            renderRecentLectures();
        }
    } catch (e) {
        console.error("loadServerLectures error:", e);
    }
}

async function selectLectureOnServer(storedName, filename) {
    try {
        const res = await fetch(`${API_URL}/select-lecture`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stored_name: storedName, filename: filename })
        });

        const data = await res.json();
        if (data.success) {
            activeLecture.filename = data.filename;
            activeLecture.stored_name = data.stored_name;
            activeLecture.transcript = data.transcript || "";
            activeLecture.notes = "";

            updateActiveLectureUI();
            if (activeLecture.transcript) {
                displayTranscript(activeLecture.transcript);
                displayNotesSection();
            }
            renderLecturesList();
            return true;
        } else {
            showToast(`Error: ${data.message}`);
            return false;
        }
    } catch (e) {
        console.error("selectLecture error:", e);
        showToast("Failed to select lecture.");
        return false;
    }
}

async function deleteLectureOnServer(storedName) {
    if (!confirm("Are you sure you want to delete this lecture?")) return;

    try {
        const res = await fetch(`${API_URL}/lectures/${encodeURIComponent(storedName)}`, {
            method: "DELETE"
        });
        const data = await res.json();

        if (data.success) {
            showToast("Lecture deleted successfully.");
            if (activeLecture.stored_name === storedName) {
                activeLecture = { filename: "", stored_name: "", transcript: "", notes: "" };
                updateActiveLectureUI();
                const transCont = document.getElementById("transcriptContainer");
                const notesCont = document.getElementById("notesContainer");
                if (transCont) transCont.innerHTML = "";
                if (notesCont) notesCont.innerHTML = "";
            }
            await loadServerLectures();
        } else {
            showToast(`Error: ${data.message}`);
        }
    } catch (e) {
        console.error("deleteLecture error:", e);
        showToast("Failed to delete lecture.");
    }
}


// RENDER MY LECTURES & RECENT LECTURES// 
function renderLecturesList() {
    const listEl = document.getElementById("lectureList");
    if (!listEl) return;

    if (serverLectures.length === 0) {
        listEl.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📚</div>
                <h3>No lectures yet</h3>
                <p>Upload your first lecture to get started.</p>
                <button type="button" class="primary-btn" onclick="showPage('upload')" style="margin-top:15px;">
                    Upload Lecture
                </button>
            </div>
        `;
        return;
    }

    const searchTerm = (lectureSearch ? lectureSearch.value : "").toLowerCase().trim();
    const filtered = serverLectures.filter(l => l.filename.toLowerCase().includes(searchTerm));

    if (filtered.length === 0) {
        listEl.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🔍</div>
                <h3>No matching lectures found</h3>
                <p>Try searching for a different keyword.</p>
            </div>
        `;
        return;
    }

    listEl.innerHTML = filtered.map(lecture => {
        const isActive = activeLecture.stored_name === lecture.stored_name;
        const words = lecture.word_count || 0;

        return `
            <div class="lecture-card searchable ${isActive ? 'is-active-card' : ''}">
                ${isActive ? '<span class="active-tag">Active</span>' : ''}
                <div>
                    <div class="lecture-card-header">
                        <div class="lecture-icon">🎥</div>
                        <h3>${escapeHTML(lecture.filename)}</h3>
                    </div>
                    <div class="lecture-card-meta">
                        <span>📝 ${words > 0 ? `${words} words transcribed` : 'Transcript saved'}</span>
                    </div>
                </div>
                <div class="lecture-card-actions">
                    <button type="button" class="secondary-btn" onclick="handleViewLecture('${escapeHTML(lecture.stored_name)}', '${escapeHTML(lecture.filename)}')">
                        📖 View Notes
                    </button>
                    <button type="button" class="primary-btn" onclick="handleAskLecture('${escapeHTML(lecture.stored_name)}', '${escapeHTML(lecture.filename)}')">
                        💬 Ask AI
                    </button>
                    <button type="button" class="secondary-btn" onclick="handleQuizLecture('${escapeHTML(lecture.stored_name)}', '${escapeHTML(lecture.filename)}')">
                        📝 Quiz
                    </button>
                    <button type="button" class="danger-btn" onclick="deleteLectureOnServer('${escapeHTML(lecture.stored_name)}')">
                        🗑️
                    </button>
                </div>
            </div>
        `;
    }).join("");
}

function renderRecentLectures() {
    const recentEl = document.getElementById("recentLectures");
    if (!recentEl) return;

    if (serverLectures.length === 0) {
        recentEl.innerHTML = `<p class="empty-hint">No lectures uploaded yet. Click 'Upload Lecture' to begin.</p>`;
        return;
    }

    const recents = serverLectures.slice(0, 4);
    recentEl.innerHTML = recents.map(lecture => {
        const isActive = activeLecture.stored_name === lecture.stored_name;
        return `
            <div class="lecture-item">
                <div class="lecture-item-info">
                    <div class="lecture-icon">🎥</div>
                    <div>
                        <h4>${escapeHTML(lecture.filename)}</h4>
                        <p>${isActive ? '🟢 Active in memory' : 'Ready for AI processing'}</p>
                    </div>
                </div>
                <div class="lecture-item-actions">
                    <button type="button" class="secondary-btn" onclick="handleViewLecture('${escapeHTML(lecture.stored_name)}', '${escapeHTML(lecture.filename)}')">
                        View
                    </button>
                    <button type="button" class="primary-btn" onclick="handleAskLecture('${escapeHTML(lecture.stored_name)}', '${escapeHTML(lecture.filename)}')">
                        Ask
                    </button>
                </div>
            </div>
        `;
    }).join("");
}

async function handleViewLecture(storedName, filename) {
    const success = await selectLectureOnServer(storedName, filename);
    if (success) {
        showPage("upload");
    }
}

async function handleAskLecture(storedName, filename) {
    const success = await selectLectureOnServer(storedName, filename);
    if (success) {
        showPage("ask");
        if (questionInput) questionInput.focus();
    }
}

async function handleQuizLecture(storedName, filename) {
    const success = await selectLectureOnServer(storedName, filename);
    if (success) {
        showPage("quiz");
        generateQuiz();
    }
}

window.handleViewLecture = handleViewLecture;
window.handleAskLecture = handleAskLecture;
window.handleQuizLecture = handleQuizLecture;
window.deleteLectureOnServer = deleteLectureOnServer;

if (lectureSearch) {
    lectureSearch.addEventListener("input", renderLecturesList);
}


// FILE UPLOAD & PIPELINE HANDLING//
function setPipelineStep(stepNumber, state) {
    const stepEl = document.getElementById(`step${stepNumber}`);
    if (!stepEl) return;

    stepEl.classList.remove("active", "done");
    const indicator = stepEl.querySelector("b");

    if (state === "active") {
        stepEl.classList.add("active");
        if (indicator) indicator.textContent = "⏳";
    } else if (state === "done") {
        stepEl.classList.add("done");
        if (indicator) indicator.textContent = "✓";
    } else {
        if (indicator) indicator.textContent = "○";
    }
}

function resetPipeline() {
    for (let i = 1; i <= 4; i++) {
        setPipelineStep(i, "waiting");
    }
}

if (fileInput) {
    fileInput.addEventListener("change", function () {
        if (this.files && this.files.length > 0) {
            handleSelectedFile(this.files[0]);
        }
    });
}

function handleSelectedFile(file) {
    if (!file) return;
    showSelectedFile(file);
}

function showSelectedFile(file) {
    if (!uploadBox) return;

    const sizeMB = (file.size / 1024 / 1024).toFixed(2);

    uploadBox.innerHTML = `
        <div class="upload-icon">🎥</div>
        <h2>${escapeHTML(file.name)}</h2>
        <p>${sizeMB} MB • Ready to Process</p>
        <button type="button" class="primary-btn" id="processLectureBtn" style="padding:12px 24px; font-size:14px;">
            🚀 Process & Transcribe Lecture
        </button>
        <div id="uploadStatus" style="margin-top:15px; width:100%;"></div>
    `;

    const processBtn = document.getElementById("processLectureBtn");
    if (processBtn) {
        processBtn.addEventListener("click", function (e) {
            e.preventDefault();
            if (!isUploading) {
                uploadLecture(file);
            }
        });
    }
}

if (uploadBox) {
    uploadBox.addEventListener("dragover", e => {
        e.preventDefault();
        uploadBox.classList.add("dragging");
    });
    uploadBox.addEventListener("dragleave", () => {
        uploadBox.classList.remove("dragging");
    });
    uploadBox.addEventListener("drop", e => {
        e.preventDefault();
        uploadBox.classList.remove("dragging");
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleSelectedFile(e.dataTransfer.files[0]);
        }
    });
}

async function uploadLecture(file) {
    if (isUploading || !file) return;
    isUploading = true;

    const processBtn = document.getElementById("processLectureBtn");
    if (processBtn) {
        processBtn.disabled = true;
        processBtn.textContent = "⏳ Uploading & Processing...";
    }

    resetPipeline();
    setPipelineStep(1, "active");
    showUploadStatus("🔌 Connecting to FastAPI server...");

    try {
        const connected = await checkFastAPI();
        if (!connected) {
            throw new Error("Could not connect to FastAPI server. Ensure it is running on port 8000.");
        }

        setPipelineStep(1, "done");
        setPipelineStep(2, "active");
        showUploadStatus("📤 Uploading file and transcribing audio with Whisper AI...<br><small>This may take a minute for large files.</small>");

        const formData = new FormData();
        formData.append("file", file, file.name);

        const response = await fetch(`${API_URL}/upload`, {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Server returned HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error(data.message || "Lecture processing failed.");
        }

        setPipelineStep(2, "done");
        setPipelineStep(3, "active");

        activeLecture.filename = data.filename || file.name;
        activeLecture.stored_name = data.stored_name || "";
        activeLecture.transcript = data.transcript || "";
        activeLecture.notes = "";

        updateActiveLectureUI();

        showUploadStatus(`
            <div style="background:#dcfce7; color:#166534; padding:15px; border-radius:10px; text-align:left;">
                <strong>✅ Lecture Successfully Transcribed!</strong><br>
                <span>📄 ${escapeHTML(activeLecture.filename)}</span><br>
                <span>📊 ${data.word_count || 0} words extracted</span>
            </div>
        `);

        if (activeLecture.transcript) {
            displayTranscript(activeLecture.transcript);
            displayNotesSection();
            generateNotes();
        }

        setPipelineStep(3, "done");
        setPipelineStep(4, "done");

        await loadServerLectures();

    } catch (err) {
        console.error("Upload error:", err);
        showUploadStatus(`❌ ${escapeHTML(err.message || String(err))}`, true);
    } finally {
        isUploading = false;
        if (processBtn) {
            processBtn.disabled = false;
            processBtn.textContent = "🚀 Process & Transcribe Lecture";
        }
    }
}

function showUploadStatus(message, isError = false) {
    const status = document.getElementById("uploadStatus");
    if (!status) return;

    status.innerHTML = `
        <div style="padding:12px; margin-top:10px; border-radius:10px; background:${isError ? '#fee2e2' : '#f1f5f9'}; color:${isError ? '#b91c1c' : '#334155'}; font-size:13px;">
            ${message}
        </div>
    `;
}


// TRANSCRIPT & NOTES RENDERING//

function displayTranscript(transcript) {
    const container = document.getElementById("transcriptContainer");
    if (!container) return;

    container.innerHTML = `
        <div class="transcript-card">
            <div class="card-top-bar">
                <h2>🎙️ Lecture Transcript</h2>
                <button type="button" class="action-bar-btn" id="copyTranscriptBtn">📋 Copy Transcript</button>
            </div>
            <div class="transcript-content" id="transcriptText">
                ${escapeHTML(transcript)}
            </div>
        </div>
    `;

    const copyBtn = document.getElementById("copyTranscriptBtn");
    if (copyBtn) {
        copyBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(transcript);
            showToast("Transcript copied to clipboard!");
        });
    }
}

function displayNotesSection() {
    const container = document.getElementById("notesContainer");
    if (!container) return;

    container.innerHTML = `
        <div class="notes-section">
            <div class="card-top-bar">
                <h2>📝 AI Study Notes</h2>
                <div style="display:flex; gap:8px;">
                    <button type="button" class="primary-btn" id="generateNotesBtn">
                        🧠 Generate Study Notes
                    </button>
                </div>
            </div>
            <div id="notesStatus"></div>
            <div id="notesBody"></div>
        </div>
    `;

    const genBtn = document.getElementById("generateNotesBtn");
    if (genBtn) {
        genBtn.addEventListener("click", generateNotes);
    }
}

async function generateNotes() {
    if (isGeneratingNotes) return;

    const btn = document.getElementById("generateNotesBtn");
    const status = document.getElementById("notesStatus");
    const body = document.getElementById("notesBody");

    if (btn) {
        btn.disabled = true;
        btn.textContent = "⏳ Generating Notes...";
    }

    if (status) {
        status.innerHTML = `
            <div style="padding:12px; border-radius:10px; background:#eef2ff; color:#4338ca; font-size:13px; margin-bottom:12px;">
                🧠 Generating structured B.Tech study notes using AI...
            </div>
        `;
    }

    isGeneratingNotes = true;

    try {
        const response = await fetch(`${API_URL}/notes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        });

        const data = await response.json();
        if (!data.success) {
            throw new Error(data.message || "Failed to generate notes.");
        }

        activeLecture.notes = data.notes;
        stats.notesCount++;
        updateStatistics();

        if (status) status.innerHTML = "";

        if (body) {
            body.innerHTML = `
                <div style="display:flex; justify-content:flex-end; gap:8px; margin-bottom:10px;">
                    <button type="button" class="action-bar-btn" id="copyNotesBtn">📋 Copy Notes</button>
                    <button type="button" class="action-bar-btn" id="downloadNotesBtn">💾 Download (.md)</button>
                </div>
                <div class="notes-content">
                    ${formatAIText(data.notes)}
                </div>
            `;

            const copyNotesBtn = document.getElementById("copyNotesBtn");
            if (copyNotesBtn) {
                copyNotesBtn.addEventListener("click", () => {
                    navigator.clipboard.writeText(data.notes);
                    showToast("Study notes copied to clipboard!");
                });
            }

            const downloadNotesBtn = document.getElementById("downloadNotesBtn");
            if (downloadNotesBtn) {
                downloadNotesBtn.addEventListener("click", () => {
                    const blob = new Blob([data.notes], { type: "text/markdown" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${activeLecture.filename || "Lecture"}_Notes.md`;
                    a.click();
                    URL.revokeObjectURL(url);
                    showToast("Notes downloaded!");
                });
            }
        }

    } catch (err) {
        console.error("Notes error:", err);
        if (status) {
            status.innerHTML = `
                <div style="padding:12px; border-radius:10px; background:#fee2e2; color:#b91c1c; font-size:13px;">
                    ❌ ${escapeHTML(err.message || String(err))}
                </div>
            `;
        }
    } finally {
        isGeneratingNotes = false;
        if (btn) {
            btn.disabled = false;
            btn.textContent = "🧠 Re-Generate Notes";
        }
    }
}


// AI QUIZ IMPLEMENTATION//

function updateQuizPrompt() {
    const promptText = document.getElementById("quizPromptText");
    if (!promptText) return;

    if (activeLecture.filename) {
        promptText.innerHTML = `Active lecture: <strong>${escapeHTML(activeLecture.filename)}</strong>. Click below to generate questions.`;
    } else {
        promptText.textContent = "Upload or select a lecture to generate customized multiple-choice questions.";
    }
}

if (generateQuizBtn) {
    generateQuizBtn.addEventListener("click", generateQuiz);
}

if (startQuizBtn) {
    startQuizBtn.addEventListener("click", generateQuiz);
}

async function generateQuiz() {
    if (isGeneratingQuiz) return;

    if (!activeLecture.transcript) {
        showToast("Please upload or select a lecture first!");
        showPage("lectures");
        return;
    }

    const container = document.getElementById("quizContainer");
    if (!container) return;

    isGeneratingQuiz = true;
    if (generateQuizBtn) generateQuizBtn.disabled = true;

    container.innerHTML = `
        <div class="quiz-card" style="text-align:center; padding:40px;">
            <div style="font-size:36px; margin-bottom:12px;">⏳</div>
            <h3>Generating AI Quiz...</h3>
            <p style="color:var(--muted); font-size:13px; margin-top:6px;">
                Analyzing lecture concepts and formulating exam-style questions.
            </p>
        </div>
    `;

    try {
        const response = await fetch(`${API_URL}/quiz`, {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        });

        const data = await response.json();
        if (!data.success) {
            throw new Error(data.message || "Failed to generate quiz.");
        }

        currentQuiz = data.questions || [];
        quizScore = 0;
        quizAnsweredCount = 0;

        renderQuiz(data.title || `Quiz: ${activeLecture.filename}`);

    } catch (err) {
        console.error("Quiz error:", err);
        container.innerHTML = `
            <div class="quiz-card" style="text-align:center; padding:30px;">
                <div style="font-size:36px; margin-bottom:12px;">❌</div>
                <h3>Failed to generate quiz</h3>
                <p style="color:var(--error); font-size:13px; margin:8px 0;">${escapeHTML(err.message || String(err))}</p>
                <button type="button" class="primary-btn" onclick="generateQuiz()" style="margin-top:10px;">Try Again</button>
            </div>
        `;
    } finally {
        isGeneratingQuiz = false;
        if (generateQuizBtn) generateQuizBtn.disabled = false;
    }
}

function renderQuiz(title) {
    const container = document.getElementById("quizContainer");
    if (!container || !currentQuiz || currentQuiz.length === 0) return;

    let html = `
        <div class="quiz-header-card">
            <div>
                <h3 style="font-size:17px; font-weight:700;">🎯 ${escapeHTML(title)}</h3>
                <p style="color:var(--muted); font-size:12px; margin-top:2px;">5 Questions • Click an option to answer</p>
            </div>
            <div style="font-size:14px; font-weight:700; color:var(--primary);" id="quizScoreTracker">
                Score: 0 / 5
            </div>
        </div>
    `;

    currentQuiz.forEach((q, qIndex) => {
        html += `
            <div class="quiz-card" id="quizQuestionCard_${qIndex}">
                <div class="quiz-question-title">
                    Q${qIndex + 1}. ${escapeHTML(q.question)}
                </div>
                <div class="quiz-options">
                    ${q.options.map((opt, optIndex) => `
                        <div class="quiz-option" data-q="${qIndex}" data-opt="${optIndex}" onclick="handleQuizAnswer(${qIndex}, ${optIndex})">
                            <span style="font-weight:700; width:22px;">${String.fromCharCode(65 + optIndex)}.</span>
                            <span>${escapeHTML(opt)}</span>
                        </div>
                    `).join("")}
                </div>
                <div class="quiz-explanation" id="quizExp_${qIndex}" style="display:none;"></div>
            </div>
        `;
    });

    html += `<div id="quizSummaryContainer"></div>`;
    container.innerHTML = html;
}

function handleQuizAnswer(qIndex, optIndex) {
    const card = document.getElementById(`quizQuestionCard_${qIndex}`);
    if (!card || card.dataset.answered === "true") return;

    card.dataset.answered = "true";
    quizAnsweredCount++;

    const question = currentQuiz[qIndex];
    const isCorrect = (optIndex === question.correct_index);

    if (isCorrect) {
        quizScore++;
    }

    // Update score tracker
    const tracker = document.getElementById("quizScoreTracker");
    if (tracker) {
        tracker.textContent = `Score: ${quizScore} / ${quizAnsweredCount}`;
    }

    // Highlight options
    const options = card.querySelectorAll(".quiz-option");
    options.forEach((optEl, i) => {
        optEl.classList.add("answered");
        if (i === question.correct_index) {
            optEl.classList.add(isCorrect ? "selected-correct" : "correct-reveal");
        } else if (i === optIndex && !isCorrect) {
            optEl.classList.add("selected-wrong");
        }
    });

    // Reveal explanation
    const expEl = document.getElementById(`quizExp_${qIndex}`);
    if (expEl) {
        expEl.style.display = "block";
        expEl.innerHTML = `
            <strong>${isCorrect ? "✅ Correct!" : "❌ Incorrect."}</strong>
            <p style="margin-top:4px;">${escapeHTML(question.explanation || "")}</p>
        `;
    }

    // If all questions answered, render summary
    if (quizAnsweredCount === currentQuiz.length) {
        stats.quizCount++;
        updateStatistics();
        renderQuizSummary();
    }
}

window.handleQuizAnswer = handleQuizAnswer;

function renderQuizSummary() {
    const summaryCont = document.getElementById("quizSummaryContainer");
    if (!summaryCont) return;

    const percentage = Math.round((quizScore / currentQuiz.length) * 100);
    let message = "Excellent work! You have mastered this lecture topic.";
    if (percentage < 60) {
        message = "Keep reviewing the study notes to strengthen your understanding.";
    } else if (percentage < 80) {
        message = "Good effort! A quick review of key concepts will get you to 100%.";
    }

    summaryCont.innerHTML = `
        <div class="quiz-summary-card">
            <h3>🎉 Quiz Complete!</h3>
            <div class="quiz-summary-score">${quizScore} / ${currentQuiz.length} (${percentage}%)</div>
            <p style="opacity:0.95; font-size:14px; max-width:500px; margin:0 auto 20px auto;">${message}</p>
            <button type="button" class="secondary-btn" onclick="generateQuiz()" style="background:white; color:var(--dark); font-weight:700; padding:10px 22px;">
                🔄 Generate New Quiz
            </button>
        </div>
    `;

    summaryCont.scrollIntoView({ behavior: "smooth" });
}

// ASK MY LECTURE (AI CHAT)//

if (askBtn) {
    askBtn.addEventListener("click", askQuestion);
}

if (questionInput) {
    questionInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            askQuestion();
        }
    });
}

if (clearChatBtn) {
    clearChatBtn.addEventListener("click", () => {
        const chatMessages = document.getElementById("chatMessages");
        if (chatMessages) {
            chatMessages.innerHTML = `
                <div class="chat-message ai-message">
                    🤖 <strong>Chat cleared.</strong> Ask me any question from your active lecture!
                </div>
            `;
        }
    });
}

async function askQuestion() {
    if (!questionInput) return;
    const question = questionInput.value.trim();
    if (!question) return;

    if (!activeLecture.transcript) {
        showToast("Please upload or select a lecture first!");
        showPage("lectures");
        return;
    }

    addUserMessage(question);
    questionInput.value = "";

    const aiMessage = addAIMessage("🤔 Thinking...");
    if (askBtn) askBtn.disabled = true;

    try {
        const response = await fetch(`${API_URL}/ask`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: question })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error(data.message || "AI could not answer.");
        }

        stats.questionCount++;
        updateStatistics();

        if (aiMessage) {
            aiMessage.innerHTML = formatAIText(data.answer);
        }

    } catch (err) {
        console.error("Ask error:", err);
        if (aiMessage) {
            aiMessage.innerHTML = `❌ ${escapeHTML(err.message || String(err))}`;
        }
    } finally {
        if (askBtn) askBtn.disabled = false;
        scrollChatToBottom();
    }
}

function addUserMessage(message) {
    const chat = document.getElementById("chatMessages");
    if (!chat) return;

    const el = document.createElement("div");
    el.className = "chat-message user-message";
    el.textContent = message;
    chat.appendChild(el);
    scrollChatToBottom();
}

function addAIMessage(message) {
    const chat = document.getElementById("chatMessages");
    if (!chat) return null;

    const el = document.createElement("div");
    el.className = "chat-message ai-message";
    el.innerHTML = message;
    chat.appendChild(el);
    scrollChatToBottom();
    return el;
}

function scrollChatToBottom() {
    const chat = document.getElementById("chatMessages");
    if (chat) {
        chat.scrollTop = chat.scrollHeight;
    }
}

// TEXT FORMATTING HELPERS// 

function formatAIText(text) {
    if (!text) return "";
    let res = escapeHTML(text);

    // Bolding **bold**
    res = res.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

    // Headers #, ##, ###
    res = res.replace(/^### (.*?)$/gm, "<h3>$1</h3>");
    res = res.replace(/^## (.*?)$/gm, "<h2>$1</h2>");
    res = res.replace(/^# (.*?)$/gm, "<h1>$1</h1>");

    // Linebreaks
    res = res.replace(/\n/g, "<br>");
    return res;
}

function escapeHTML(str) {
    if (str == null) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}


// INITIALIZATION// 

document.addEventListener("DOMContentLoaded", async function () {
    console.log("LectureAI Client Initializing...");

    loadSavedStats();
    updateStatistics();

    const isConnected = await checkFastAPI();
    const statusEl = document.getElementById("analyticsAIStatus");
    if (statusEl) {
        statusEl.textContent = isConnected ? "FastAPI & Groq Online" : "FastAPI Offline";
        if (!isConnected) statusEl.classList.remove("green");
    }

    if (isConnected) {
        // Fetch server health to see if there is an active lecture
        try {
            const healthRes = await fetch(`${API_URL}/health`);
            const healthData = await healthRes.json();
            if (healthData.transcript_available) {
                const transRes = await fetch(`${API_URL}/transcript`);
                const transData = await transRes.json();
                if (transData.success) {
                    activeLecture.filename = transData.filename;
                    activeLecture.stored_name = transData.stored_name;
                    activeLecture.transcript = transData.transcript;
                    updateActiveLectureUI();
                    displayTranscript(activeLecture.transcript);
                    displayNotesSection();
                }
            }
        } catch (e) {
            console.error("Health sync error:", e);
        }

        await loadServerLectures();

        // If no active lecture was set, auto-select the first one available
        if (!activeLecture.stored_name && serverLectures.length > 0) {
            await selectLectureOnServer(serverLectures[0].stored_name, serverLectures[0].filename);
        }
    }
});