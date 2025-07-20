# client/app.py
from pathlib import Path
from fastapi import FastAPI, Request, Query, Body
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import urllib.request
import json

BASE_DIR = Path(__file__).resolve().parent

@asynccontextmanager
async def lifespan(app: FastAPI):
    # startup: local src/ → server(8000)/api/sync_src
    SRC_DIR = BASE_DIR / "src"
    files = []
    for f in SRC_DIR.rglob("*.py"):
        rel = f.relative_to(SRC_DIR)
        files.append({"path": str(rel), "content": f.read_text(encoding="utf-8")})
    data = json.dumps({"files": files}).encode("utf-8")
    req = urllib.request.Request(
        "http://localhost:8000/api/sync_src",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        if resp.status != 200:
            raise RuntimeError(f"sync_src failed: {resp.status}")
    yield
    # shutdown: nothing special

app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"],
    allow_headers=["*"], allow_credentials=True,
)

# serve static files and templates
app.mount("/static", StaticFiles(directory=BASE_DIR/"res", html=True), name="frontend")
templates = Jinja2Templates(directory=BASE_DIR/"res")

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# ─────────────────────────────────────────────────
# 1) Directory listing proxy
# ─────────────────────────────────────────────────
@app.post("/api/list")
def api_list_post(payload: dict = Body(...)):
    data = json.dumps({"path": payload.get("path", "")}).encode("utf-8")
    req = urllib.request.Request(
        "http://localhost:8000/api/list",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)

@app.get("/api/list")
def api_list_get(path: str = Query("")):
    return api_list_post({"path": path})

# ─────────────────────────────────────────────────
# 2) File read proxy
# ─────────────────────────────────────────────────
@app.post("/api/file")
def proxy_file(req_body: dict = Body(...)):
    data = json.dumps({"path": req_body["path"]}).encode("utf-8")
    r = urllib.request.Request(
        "http://localhost:8000/api/file",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(r, timeout=10) as resp:
        return JSONResponse(status_code=resp.getcode(), content=json.load(resp))

# ─────────────────────────────────────────────────
# 3) Kernel start proxy
# ─────────────────────────────────────────────────
@app.post("/kernels/start")
def proxy_start(req_body: dict = Body(...)):
    data = json.dumps(req_body).encode("utf-8")
    r = urllib.request.Request(
        "http://localhost:8000/kernels/start",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(r, timeout=10) as resp:
        return JSONResponse(status_code=resp.getcode(), content=json.load(resp))

# ─────────────────────────────────────────────────
# 4) Kernel execute proxy
# ─────────────────────────────────────────────────
@app.post("/kernels/execute")
def proxy_execute(req_body: dict = Body(...)):
    data = json.dumps(req_body).encode("utf-8")
    r = urllib.request.Request(
        "http://localhost:8000/kernels/execute",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(r, timeout=30) as resp:
        return JSONResponse(status_code=resp.getcode(), content=json.load(resp))

# ─────────────────────────────────────────────────
# 5) Save file proxy (server workspace + local src/)
# ─────────────────────────────────────────────────
@app.post("/api/save")
def proxy_save(req_body: dict = Body(...)):
    path    = req_body["path"]
    content = req_body["content"]

    # 5-1) 서버 워크스페이스에 저장
    data = json.dumps({"path": path, "content": content}).encode("utf-8")
    req = urllib.request.Request(
        "http://localhost:8000/api/save",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        server_resp = json.load(resp)

    # 5-2) 로컬 src/ 디렉터리에 덮어쓰기
    local_file = BASE_DIR / "src" / path
    local_file.parent.mkdir(parents=True, exist_ok=True)
    local_file.write_text(content, encoding="utf-8")

    return JSONResponse(status_code=200, content={
        "saved_server": server_resp,
        "saved_local":  True
    })
@app.post("/kernels/shutdown")
def proxy_shutdown(req_body: dict = Body(...)):
    data = json.dumps(req_body).encode("utf-8")
    req = urllib.request.Request(
        "http://localhost:8000/kernels/shutdown",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        content = json.load(resp)
        return JSONResponse(status_code=resp.getcode(), content=content)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8888, log_level="info")
