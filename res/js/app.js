// res/static/js/app.js

document.addEventListener('DOMContentLoaded', () => {
    const tree       = document.getElementById('file-tree');
    const bread      = document.getElementById('breadcrumb');
    const tabs       = document.getElementById('tab-bar');
    const cellsDiv   = document.getElementById('cells');
    const addCellBtn = document.getElementById('add-cell-btn');
    const runAllBtn  = document.getElementById('run-btn');
    const saveBtn    = document.getElementById('save-btn');
    const shutdownBtn  = document.getElementById('shutdown-btn'); // ← 추가

    let ws             = null;
    let openTabs       = [];   // [{ path, kernel, cells: [code], outputs: [any], execCounts: [number] }]
    let activeTab      = null;
    let globalExecCount = 1;

    const CLIENT_API = '';
    const WS_URL     = 'ws://localhost:8000';

    // ──────────────────────────────────────────────────────────
    // 1) 디렉터리 트리 로드
    // ──────────────────────────────────────────────────────────
    async function loadDir(path = '') {
        const res = await fetch(`${CLIENT_API}/api/list`, {
            method:  'POST',
            headers: { 'Content-Type':'application/json' },
            body:    JSON.stringify({ path })
        });
        if (!res.ok) { console.error('목록 로드 실패', res.status); return; }
        const list = await res.json();

        if (path) {
            const parent = path.split('/').slice(0,-1).join('/');
            bread.innerHTML = `<a href="#" id="back-btn">⬅️</a> / ${path}`;
            document.getElementById('back-btn').onclick = e => {
                e.preventDefault();
                loadDir(parent);
            };
        } else {
            bread.textContent = 'src/';
        }

        tree.innerHTML = '';
        list.forEach(e => {
            const li = document.createElement('li');
            li.textContent  = e.name + (e.is_dir ? '/' : '');
            li.dataset.path = e.path;
            li.className    = e.is_dir ? 'dir' : 'file';
            tree.appendChild(li);
        });

        clearEditor();
    }

    function clearEditor() {
        cellsDiv.innerHTML   = '';
        tabs.innerHTML       = '';
        openTabs             = [];
        activeTab            = null;
        addCellBtn.disabled  = true;
        runAllBtn.disabled   = true;
        saveBtn.disabled     = true;
        shutdownBtn.disabled  = false; // ← 커널 종료 버튼 활성화
        if (ws) ws.close();
    }

    // ──────────────────────────────────────────────────────────
    // 2) 탭 생성/선택
    // ──────────────────────────────────────────────────────────
    function addTab(path, fullContent, kernel) {
        let tab = openTabs.find(t => t.path === path);
        if (!tab) {
            const cells = fullContent
                .split(/^\s*#\s*%%.*$/m)
                .map(p => p.trim())
                .filter(p => p);

            tab = {
                path,
                kernel,
                cells,
                outputs:   new Array(cells.length).fill(null),
                execCounts:new Array(cells.length).fill(null)
            };
            openTabs.push(tab);

            const div = document.createElement('div');
            div.className   = 'tab';
            div.textContent = path.split('/').pop();
            div.onclick     = () => selectTab(tab);
            tabs.appendChild(div);
        }
        selectTab(tab);
    }

    function selectTab(tab) {
        activeTab = tab;
        tabs.querySelectorAll('.tab').forEach(el => {
            el.classList.toggle('active',
                el.textContent === tab.path.split('/').pop()
            );
        });

        cellsDiv.innerHTML = '';
        tab.cells.forEach((code, idx) => {
            const cellEl = document.createElement('div');
            cellEl.className = 'cell';

            // header: In [n]:
            const header = document.createElement('div');
            header.className = 'cell-header';
            const count = tab.execCounts[idx];
            header.textContent = count != null ? `In [${count}]:` : '';

            // textarea
            const ta = document.createElement('textarea');
            ta.className = 'cell-editor';
            ta.value     = code;

            // run button
            const btn = document.createElement('button');
            btn.textContent = '▷ Run Cell';
            btn.onclick     = () => runCell(idx);

            // output
            const out = document.createElement('pre');
            out.className = 'cell-output';
            if (tab.outputs[idx] != null) {
                const res = tab.outputs[idx];
                out.textContent = typeof res === 'string'
                    ? res
                    : JSON.stringify(res, null, 2);
            }

            cellEl.append(header, ta, btn, out);
            cellsDiv.appendChild(cellEl);
        });

        addCellBtn.disabled = false;
        runAllBtn.disabled  = false;
        saveBtn.disabled    = false;
    }

    // ──────────────────────────────────────────────────────────
    // 3) 파일 열기 → 커널 시작 → WS 연결
    // ──────────────────────────────────────────────────────────
    async function openFile(path) {
        // read file
        const fileRes = await fetch(`${CLIENT_API}/api/file`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ path })
        });
        if (!fileRes.ok) { console.error('파일 읽기 실패'); return; }
        const { content } = await fileRes.json();

        // start kernel
        const startRes = await fetch('/kernels/start', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ notebook_path: path })
        });
        if (!startRes.ok) { console.error('커널 시작 실패'); return; }
        const { kernel_id } = await startRes.json();

        // open WS
        if (ws) ws.close();
        ws = new WebSocket(`${WS_URL}/ws/${kernel_id}`);
        ws.onopen = () => ws.send(JSON.stringify({ type:'open_file', file_path: path }));
        ws.onmessage = e => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'file_opened') {
                addTab(path, msg.content, kernel_id);
            }
        };
    }

    // ──────────────────────────────────────────────────────────
    // 4) Run Cell (idx 번째 셀만 실행)
    // ──────────────────────────────────────────────────────────
    async function runCell(idx) {
        const tab   = activeTab;
        const cellEl= cellsDiv.children[idx];
        const ta    = cellEl.querySelector('textarea');
        const outEl = cellEl.querySelector('.cell-output');
        const hdrEl = cellEl.querySelector('.cell-header');

        const code = ta.value;

        const res = await fetch('/kernels/execute', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
                code,
                kernel_id:     tab.kernel,
                notebook_path: tab.path
            })
        });
        if (!res.ok) {
            outEl.textContent = 'Error: ' + await res.text();
            return;
        }
        const { result } = await res.json();

        // record output & exec count
        const execNo = globalExecCount++;
        tab.execCounts[idx] = execNo;
        tab.outputs[idx]    = result;

        // update UI
        hdrEl.textContent = `In [${execNo}]:`;
        outEl.textContent = result && result.no_output
            ? ''
            : (typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2));
    }

    // ──────────────────────────────────────────────────────────
    // 5) Run All
    // ──────────────────────────────────────────────────────────
    runAllBtn.onclick = async () => {
        const tab = activeTab;
        if (!tab) return;

        // gather code from DOM
        const codes = Array.from(cellsDiv.children).map(cellEl =>
            cellEl.querySelector('textarea').value
        );
        const full = codes.join('\n\n# %%\n\n');

        const res = await fetch('/kernels/execute', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
                code: full,
                kernel_id:     tab.kernel,
                notebook_path: tab.path
            })
        });
        if (!res.ok) {
            alert('Run All 실패: ' + await res.text());
            return;
        }
        const { result } = await res.json();

        // show under last cell
        const lastIdx = tab.cells.length - 1;
        tab.execCounts[lastIdx] = globalExecCount++;
        tab.outputs[lastIdx]    = result;

        const lastCell = cellsDiv.children[lastIdx];
        lastCell.querySelector('.cell-header').textContent = `In [${tab.execCounts[lastIdx]}]:`;
        lastCell.querySelector('.cell-output').textContent =
            result && result.no_output
                ? ''
                : (typeof result === 'string'
                    ? result
                    : JSON.stringify(result, null, 2));
    };

    // ──────────────────────────────────────────────────────────
    // 6) Add Cell
    // ──────────────────────────────────────────────────────────
    addCellBtn.onclick = () => {
        const tab = activeTab;
        if (!tab) return;
        tab.cells.push('');
        tab.outputs.push(null);
        tab.execCounts.push(null);
        selectTab(tab);
    };

    // ──────────────────────────────────────────────────────────
    // 7) Save (merge & write)
    // ──────────────────────────────────────────────────────────
    saveBtn.onclick = async () => {
        const tab = activeTab;
        if (!tab) return;
        // sync DOM -> tab.cells
        tab.cells = Array.from(cellsDiv.children).map(cellEl =>
            cellEl.querySelector('textarea').value
        );
        const full = tab.cells.join('\n\n# %%\n\n');
        await fetch('/api/save', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ path: tab.path, content: full })
        });
    };

    // ──────────────────────────────────────────────────────────
    // 8) 사이드바 클릭
    // ──────────────────────────────────────────────────────────
    tree.onclick = e => {
        const li = e.target.closest('li');
        if (!li) return;
        const p = li.dataset.path;
        if (li.classList.contains('dir')) loadDir(p);
        else if (p.endsWith('.py')) openFile(p);
    };
    // ──────────────────────────────────────────────────────────
    // 9) Stop Kernel (현재 탭의 커널 종료)
    // ──────────────────────────────────────────────────────────
    shutdownBtn.onclick = async () => {
        if (!activeTab) return;
        const { path, kernel } = activeTab;
        // API 호출
        const res = await fetch('/kernels/shutdown', {
            method: 'POST',
            headers: { 'Content-Type':'application/json' },
            body: JSON.stringify({ notebook_path: activeTab.path, kernel_id: activeTab.kernel })
        });
        if (!res.ok) {
            alert('커널 종료 실패: ' + await res.text());
            return;
        }
        // WebSocket 닫기 & UI 초기화
        if (ws) ws.close();
        alert(`Stopped kernel for ${path}`);
        clearEditor();
    };

    // 초기 로드
    loadDir();
});
