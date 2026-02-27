(function () {
  const vscode = acquireVsCodeApi();

  const listEl = document.getElementById('list');
  const subtitleEl = document.getElementById('subtitle');
  const summaryEl = document.getElementById('summary');

  const btnKeepAll = document.getElementById('btnKeepAll');
  const btnUndoAll = document.getElementById('btnUndoAll');
  const btnOpenAll = document.getElementById('btnOpenAll');

  let state = {
    requestId: '',
    summary: '',
    files: [],
    diffStats: null,
    canPreview: false,
  };

  function split(filePath) {
    const raw = String(filePath || '').trim();
    const normalized = raw.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const fileName = parts.length ? parts[parts.length - 1] : normalized;
    const rootLabel = parts.length > 1 ? parts[0] : '';
    const dir = parts.length > 2 ? parts.slice(1, -1).join('/') : '';
    const dirTail = dir.length > 34 ? `…/${dir.slice(-32)}` : dir;
    return { fileName, rootLabel, dirTail };
  }

  function post(msg) {
    vscode.postMessage(msg);
  }

  function render() {
    const rid = String(state.requestId || '').trim();
    const files = Array.isArray(state.files) ? state.files : [];

    const diffStats = state.diffStats && typeof state.diffStats === 'object' ? state.diffStats : null;
    const filesChanged = diffStats ? Number(diffStats.filesChanged ?? files.length) : files.length;
    const additions = diffStats ? Number(diffStats.additions ?? 0) : 0;
    const deletions = diffStats ? Number(diffStats.deletions ?? 0) : 0;

    if (subtitleEl) subtitleEl.textContent = rid ? `${filesChanged} files changed` : '等待数据…';
    if (summaryEl) summaryEl.textContent = rid ? `+${Math.max(0, additions)}  -${Math.max(0, deletions)}` : '';

    if (btnKeepAll) btnKeepAll.disabled = !rid || files.length === 0;
    if (btnUndoAll) btnUndoAll.disabled = !rid || files.length === 0;
    if (btnOpenAll) btnOpenAll.disabled = !rid || files.length === 0;

    if (!listEl) return;
    listEl.innerHTML = '';

    if (!rid || !files.length) {
      const empty = document.createElement('div');
      empty.style.padding = '12px';
      empty.style.opacity = '0.85';
      empty.textContent = rid ? '没有需要审阅的更改。' : '等待更改…';
      listEl.appendChild(empty);
      return;
    }

    for (const f of files) {
      const rel = String(f?.relativePath ?? '').trim();
      if (!rel) continue;
      const add = Number(f?.additions ?? 0);
      const del = Number(f?.deletions ?? 0);
      const changeType = String(f?.changeType ?? '').trim().toUpperCase();

      const row = document.createElement('div');
      row.className = 'editsReviewRow';
      row.setAttribute('role', 'listitem');
      if (changeType) row.dataset.changeType = changeType;

      const main = document.createElement('div');
      main.className = 'editsReviewRowMain';
      const { fileName, rootLabel, dirTail } = split(rel);

      const fileEl = document.createElement('div');
      fileEl.className = 'editsReviewRowFile';
      if (changeType) {
        const badge = document.createElement('span');
        badge.className = 'editsReviewChangeBadge';
        badge.textContent = changeType;
        fileEl.appendChild(badge);
      }
      const fileText = document.createElement('span');
      fileText.textContent = fileName;
      fileEl.appendChild(fileText);

      const pathEl = document.createElement('div');
      pathEl.className = 'editsReviewRowPath';
      pathEl.textContent = [rootLabel, dirTail].filter(Boolean).join(' • ') || rel;

      main.appendChild(fileEl);
      main.appendChild(pathEl);

      const meta = document.createElement('div');
      meta.className = 'editsReviewRowMeta';

      const addEl = document.createElement('span');
      addEl.className = 'editsReviewStat editsReviewStatAdd';
      addEl.textContent = `+${Math.max(0, add)}`;

      const delEl = document.createElement('span');
      delEl.className = 'editsReviewStat editsReviewStatDel';
      delEl.textContent = `-${Math.max(0, del)}`;

      const actions = document.createElement('div');
      actions.className = 'editsReviewRowActions';

      const btnOpen = document.createElement('button');
      btnOpen.type = 'button';
      btnOpen.className = 'ghost';
      btnOpen.textContent = '打开文件';
      btnOpen.addEventListener('click', (e) => {
        e.preventDefault();
        post({ type: 'uiAction', action: 'openChangedFile', payload: { file: rel, requestId: rid } });
      });

      const btnKeep = document.createElement('button');
      btnKeep.type = 'button';
      btnKeep.textContent = '保留';
      btnKeep.addEventListener('click', (e) => {
        e.preventDefault();
        post({ type: 'editReviewAction', requestId: rid, action: 'keep', file: rel });
      });

      const btnUndo = document.createElement('button');
      btnUndo.type = 'button';
      btnUndo.className = 'ghost';
      btnUndo.textContent = '撤销';
      btnUndo.addEventListener('click', (e) => {
        e.preventDefault();
        post({ type: 'editReviewAction', requestId: rid, action: 'undo', file: rel });
      });

      actions.appendChild(btnOpen);
      actions.appendChild(btnKeep);
      actions.appendChild(btnUndo);

      meta.appendChild(addEl);
      meta.appendChild(delEl);
      meta.appendChild(actions);

      row.appendChild(main);
      row.appendChild(meta);
      listEl.appendChild(row);
    }
  }

  if (btnKeepAll) {
    btnKeepAll.addEventListener('click', () => {
      const rid = String(state.requestId || '').trim();
      if (!rid) return;
      post({ type: 'editReviewAction', requestId: rid, action: 'keep' });
    });
  }

  if (btnUndoAll) {
    btnUndoAll.addEventListener('click', () => {
      const rid = String(state.requestId || '').trim();
      if (!rid) return;
      post({ type: 'editReviewAction', requestId: rid, action: 'undo' });
    });
  }

  if (btnOpenAll) {
    btnOpenAll.addEventListener('click', () => {
      post({ type: 'uiAction', action: 'openAllDiffs' });
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'editsReviewPanelData') {
      state = {
        requestId: String(msg.requestId || ''),
        summary: String(msg.summary || ''),
        files: Array.isArray(msg.files) ? msg.files : [],
        diffStats: msg.diffStats && typeof msg.diffStats === 'object' ? msg.diffStats : null,
        canPreview: !!msg.canPreview,
      };
      render();
      return;
    }

    if (msg.type === 'editsReviewPanelClear') {
      const rid = String(msg.requestId || '');
      if (!rid || rid === String(state.requestId || '')) {
        state = { requestId: '', summary: '', files: [], diffStats: null, canPreview: false };
        render();
      }
      return;
    }
  });

  // Handshake
  post({ type: 'editsReviewPanelReady' });
  render();
})();
