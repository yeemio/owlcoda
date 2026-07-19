export interface DesktopRendererOptions {
  appServerUrl: string
}

export function renderDesktopRenderer(options: DesktopRendererOptions): string {
  const appServerUrl = JSON.stringify(options.appServerUrl)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OwlCoda Desktop</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --panel: #ffffff;
      --panel-soft: #f1f4f1;
      --ink: #1d252c;
      --muted: #66717c;
      --line: #d8ded7;
      --accent: #0f766e;
      --accent-ink: #ffffff;
      --warn: #b45309;
      --danger: #b42318;
      --code: #28323a;
      --blue: #2563eb;
      --rose: #be123c;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      letter-spacing: 0;
    }
    button, input, textarea { font: inherit; letter-spacing: 0; }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--ink);
      min-height: 32px;
      padding: 0 10px;
      cursor: pointer;
    }
    button:hover { border-color: #9fb0a6; background: #f9faf8; }
    button.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); }
    button.ghost { width: 32px; padding: 0; display: inline-grid; place-items: center; }
    button.tab {
      border: 0;
      border-radius: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      min-height: 36px;
      padding: 0 4px;
      color: var(--muted);
    }
    button.tab.active { color: var(--ink); border-bottom-color: var(--accent); }
    input, textarea {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
    }
    #owlcoda-desktop-shell {
      height: 100vh;
      min-height: 640px;
      display: grid;
      grid-template-columns: minmax(220px, 16vw) minmax(520px, 1fr) minmax(280px, 22vw);
      overflow: hidden;
    }
    .nav, .rail {
      background: var(--panel-soft);
      border-color: var(--line);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .nav { border-right: 1px solid var(--line); }
    .rail { border-left: 1px solid var(--line); }
    .work {
      background: var(--panel);
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      min-width: 0;
      min-height: 0;
    }
    .topbar, .section-head, .composer {
      border-bottom: 1px solid var(--line);
      padding: 12px;
      display: flex;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .composer { border-top: 1px solid var(--line); border-bottom: 0; align-items: stretch; }
    .brand {
      height: 56px;
      padding: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--line);
    }
    .brand strong { font-size: 16px; }
    .badge {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--muted);
      background: rgba(255,255,255,0.7);
      font-size: 12px;
      white-space: nowrap;
    }
    .stack { min-height: 0; overflow: auto; padding: 10px; }
    .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      margin: 12px 2px 6px;
    }
    .row {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 8px;
      background: transparent;
      text-align: left;
    }
    .row.active { background: #fff; border-color: var(--line); }
    .row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-sub { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .grow { flex: 1; min-width: 0; }
    .title { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .subtitle { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tabs {
      display: flex;
      gap: 18px;
      padding: 0 12px;
      border-bottom: 1px solid var(--line);
      min-height: 38px;
    }
    .surface { min-height: 0; overflow: auto; padding: 18px; }
    .empty {
      min-height: 180px;
      display: grid;
      place-items: center;
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 8px;
      background: #fbfcfa;
      text-align: center;
    }
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 980px;
      margin: 0 auto;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 12px;
    }
    .item.user { border-left: 4px solid var(--blue); }
    .item.assistant { border-left: 4px solid var(--accent); }
    .item.tool { border-left: 4px solid var(--warn); }
    .item.live { background: #fffdfa; }
    .item.failed { border-left-color: var(--danger); }
    .item-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .mono {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      color: var(--code);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; }
    .split {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .status.ready { color: var(--accent); }
    .status.blocked, .status.failed { color: var(--danger); }
    .status.applied, .status.completed { color: var(--blue); }
    .status.streaming, .status.running { color: var(--accent); }
    .status.interrupted { color: var(--warn); }
    .review-list { display: flex; flex-direction: column; gap: 10px; }
    .review-actions { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .hunk-list { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; }
    .hunk-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
    .hunk-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .approval-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .live-events {
      border-bottom: 1px solid var(--line);
      background: #fbfcfa;
      padding: 8px 12px;
      min-height: 42px;
      max-height: 132px;
      overflow: auto;
    }
    .live-events.empty {
      min-height: 42px;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      background: #fbfcfa;
      color: var(--muted);
    }
    .live-event-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .live-event {
      display: grid;
      grid-template-columns: 120px minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
    }
    .live-event strong { color: var(--ink); font-weight: 650; }
    .live-event span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rail .section-head { min-height: 56px; }
    .rail-block {
      border-bottom: 1px solid var(--line);
      padding: 12px;
    }
    .rail-block h3 {
      margin: 0 0 8px;
      font-size: 13px;
    }
    .rail-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    textarea {
      flex: 1;
      min-height: 52px;
      max-height: 140px;
      resize: vertical;
      padding: 10px;
    }
    .toast {
      position: fixed;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%);
      background: var(--ink);
      color: #fff;
      border-radius: 8px;
      padding: 10px 14px;
      max-width: min(720px, 88vw);
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      display: none;
    }
    .toast.show { display: block; }
    @media (max-width: 980px) {
      #owlcoda-desktop-shell {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr auto;
      }
      .nav, .rail {
        max-height: 220px;
        border-right: 0;
        border-left: 0;
      }
      .nav { border-bottom: 1px solid var(--line); }
      .rail { border-top: 1px solid var(--line); }
      .split { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main id="owlcoda-desktop-shell">
    <aside class="nav" data-surface="project-thread-nav">
      <div class="brand">
        <strong>OwlCoda</strong>
        <button id="refreshShell" class="ghost" title="刷新">↻</button>
      </div>
      <div class="stack">
        <div class="label">Projects</div>
        <div id="projectList"></div>
        <div class="section-head" style="padding-left:0;padding-right:0;border-bottom:0;">
          <div class="grow">
            <div class="label" style="margin:0;">Threads</div>
          </div>
          <button id="newThread" class="ghost" title="新线程">+</button>
        </div>
        <div id="threadList"></div>
      </div>
    </aside>
    <section class="work" data-surface="runtime-workspace">
      <header class="topbar">
        <div class="grow">
          <div id="threadTitle" class="title">OwlCoda Desktop</div>
          <div id="threadMeta" class="subtitle">App Server renderer</div>
        </div>
        <span id="healthBadge" class="badge">v0</span>
      </header>
      <nav class="tabs">
        <button id="tabTranscript" class="tab active">Transcript</button>
        <button id="tabApprovals" class="tab">Approvals</button>
        <button id="tabReview" class="tab">Review</button>
      </nav>
      <section id="liveEventStream" class="live-events empty" data-surface="live-runtime-events">Waiting for runtime events</section>
      <div id="workspaceSurface" class="surface"></div>
      <footer class="composer">
        <textarea id="composerInput" placeholder="向 OwlCoda 输入任务"></textarea>
        <button id="sendTurn" class="primary" title="发送">Send</button>
      </footer>
    </section>
    <aside class="rail" data-surface="runkit-runtime-rail">
      <div class="section-head">
        <div class="grow">
          <div class="title">RunKit</div>
          <div id="railFreshness" class="subtitle">rail</div>
        </div>
      </div>
      <div id="railSurface" class="stack"></div>
    </aside>
  </main>
  <span id="protocolContract" hidden data-surface="app-server-protocol-contract" data-product-boundary="debug-renderer" data-debug-scope="operator-smoke" data-not-product-ui="true"></span>
  <div id="toast" class="toast"></div>
  <script>
    window.__OWLCODA_DESKTOP__ = { appServerUrl: ${appServerUrl} };
    const state = {
      protocol: null,
      health: null,
      projects: [],
      project: null,
      threads: [],
      thread: null,
      transcript: null,
      approvals: null,
      interactions: null,
      review: null,
      rail: null,
      runtimeFacts: null,
      structuredOutputArtifacts: null,
      providerEvalReport: null,
      liveRuntimeState: createLiveRuntimeState(),
      liveEvents: [],
      tab: 'transcript'
    };
    const appServerUrl = window.__OWLCODA_DESKTOP__.appServerUrl.replace(/\\/+$/, '');
    const el = (id) => document.getElementById(id);

    async function rpc(method, params) {
      const response = await fetch(appServerUrl + '/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: method + ':' + Date.now(), method, params: params || {} })
      });
      const body = await response.json();
      if (body.error) {
        const error = new Error(body.error.message);
        error.code = body.error.code;
        error.data = body.error.data;
        throw error;
      }
      return body.result;
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function shortPath(value) {
      const text = String(value || '');
      const parts = text.split('/');
      return parts.slice(Math.max(0, parts.length - 3)).join('/') || text;
    }

    function jsonPreview(value) {
      try {
        return JSON.stringify(value || {}, null, 2);
      } catch {
        return String(value);
      }
    }

    async function refreshShell() {
      try {
        state.protocol = await rpc('protocol/describe');
        state.health = await rpc('diagnostic/health');
        const projectList = await rpc('project/list');
        state.projects = projectList.projects || [];
        state.project = state.project
          ? (state.projects.find((project) => project.id === state.project.id) || state.projects[0] || null)
          : (state.projects[0] || null);
        if (state.project) {
          const aggregate = await rpc('project/get', { projectId: state.project.id });
          state.rail = aggregate.rail;
          const listed = await rpc('thread/list', { projectId: state.project.id });
          state.threads = listed.threads || [];
          state.thread = state.thread
            ? (state.threads.find((thread) => thread.id === state.thread.id) || state.threads[0] || null)
            : (state.threads[0] || null);
        }
        await loadThreadSurfaces();
        render();
      } catch (error) {
        showToast(error.message || 'App Server error');
        render();
      }
    }

    async function loadThreadSurfaces() {
      state.transcript = null;
      state.approvals = null;
      state.interactions = null;
      state.review = null;
      state.runtimeFacts = null;
      state.structuredOutputArtifacts = null;
      state.providerEvalReport = null;
      if (!state.project) return;
      state.rail = await rpc('runtimeRail/read', { projectId: state.project.id });
      state.providerEvalReport = await loadProviderEvalReport();
      if (!state.thread) return;
      state.transcript = await rpc('runtimeTranscript/read', {
        projectId: state.project.id,
        threadId: state.thread.id
      });
      const runId = latestRunIdFromTranscript(state.transcript);
      state.runtimeFacts = await loadRuntimeFactsSummary(runId);
      state.structuredOutputArtifacts = await loadStructuredOutputArtifacts(runId);
      state.approvals = await rpc('approval/list', {
        projectId: state.project.id,
        threadId: state.thread.id
      });
      state.interactions = await rpc('interaction/list', {
        projectId: state.project.id,
        threadId: state.thread.id
      });
      const listed = await rpc('review/list', {
        projectId: state.project.id,
        threadId: state.thread.id
      });
      const diffIds = (listed.changes || []).map((change) => change.id);
      let preflight = null;
      if (diffIds.length > 0) {
        preflight = await rpc('review/batchPreflight', {
          projectId: state.project.id,
          threadId: state.thread.id,
          diffIds
        });
      }
      state.review = { changes: listed.changes || [], preflight };
    }

    async function loadRuntimeFactsSummary(runId) {
      if (!state.project || !state.thread) return null;
      if (!runId) {
        return {
          unavailable: true,
          message: 'no runId in runtime transcript'
        };
      }
      try {
        return await rpc('runtimeFacts/read', {
          projectId: state.project.id,
          threadId: state.thread.id,
          runId
        });
      } catch (error) {
        return {
          unavailable: true,
          runId,
          message: error && error.message ? error.message : 'runtime facts unavailable'
        };
      }
    }

    async function loadStructuredOutputArtifacts(runId) {
      if (!state.project || !state.thread) return null;
      if (!runId) {
        return {
          unavailable: true,
          message: 'no runId in runtime transcript'
        };
      }
      try {
        return await rpc('structuredOutputArtifacts/read', {
          projectId: state.project.id,
          threadId: state.thread.id,
          runId
        });
      } catch (error) {
        return {
          unavailable: true,
          runId,
          message: error && error.message ? error.message : 'structured output artifacts unavailable'
        };
      }
    }

    async function loadProviderEvalReport() {
      try {
        return await rpc('benchmark/providerEvalReport/read');
      } catch (error) {
        return {
          unavailable: true,
          message: error && error.message ? error.message : 'provider eval report unavailable'
        };
      }
    }

    function render() {
      renderProjects();
      renderThreads();
      renderHeader();
      renderLiveEvents();
      renderWorkspace();
      renderRail();
    }

    function renderProjects() {
      el('projectList').innerHTML = state.projects.map((project) => (
        '<button class="row ' + (state.project && project.id === state.project.id ? 'active' : '') + '" data-project-id="' + escapeHtml(project.id) + '">' +
          '<span class="grow"><span class="row-title">' + escapeHtml(project.name || project.id) + '</span>' +
          '<span class="row-sub">' + escapeHtml(shortPath(project.root)) + '</span></span>' +
        '</button>'
      )).join('') || '<div class="empty">No project</div>';
      document.querySelectorAll('[data-project-id]').forEach((node) => {
        node.addEventListener('click', async () => {
          state.project = state.projects.find((project) => project.id === node.getAttribute('data-project-id')) || null;
          state.thread = null;
          resetLiveRuntimeState();
          await refreshShell();
        });
      });
    }

    function renderThreads() {
      el('threadList').innerHTML = state.threads.map((thread) => (
        '<button class="row ' + (state.thread && thread.id === state.thread.id ? 'active' : '') + '" data-thread-id="' + escapeHtml(thread.id) + '">' +
          '<span class="grow"><span class="row-title">' + escapeHtml(thread.title || thread.id) + '</span>' +
          '<span class="row-sub">' + escapeHtml(thread.turnCount + ' turns · ' + thread.model) + '</span></span>' +
        '</button>'
      )).join('') || '<div class="empty">No thread</div>';
      document.querySelectorAll('[data-thread-id]').forEach((node) => {
        node.addEventListener('click', async () => {
          state.thread = state.threads.find((thread) => thread.id === node.getAttribute('data-thread-id')) || null;
          resetLiveRuntimeState();
          await loadThreadSurfaces();
          render();
        });
      });
    }

    function renderHeader() {
      el('threadTitle').textContent = state.thread ? state.thread.title : 'OwlCoda Desktop';
      el('threadMeta').textContent = state.thread
        ? state.thread.id + ' · ' + state.thread.turnCount + ' turns'
        : (state.project ? state.project.root : 'No project');
      el('healthBadge').textContent = state.protocol ? state.protocol.protocolVersion : 'offline';
      renderProtocolContract();
      el('tabTranscript').className = 'tab ' + (state.tab === 'transcript' ? 'active' : '');
      el('tabApprovals').className = 'tab ' + (state.tab === 'approvals' ? 'active' : '');
      el('tabReview').className = 'tab ' + (state.tab === 'review' ? 'active' : '');
    }

    function renderProtocolContract() {
      const node = el('protocolContract');
      if (!node) return;
      const methods = state.protocol && Array.isArray(state.protocol.methods) ? state.protocol.methods : [];
      node.setAttribute('data-protocol-version', state.protocol ? state.protocol.protocolVersion : 'offline');
      node.setAttribute('data-stable-method-count', String(methods.filter((method) => method.stability === 'stable').length));
      node.setAttribute('data-experimental-method-count', String(methods.filter((method) => method.stability === 'experimental').length));
      node.textContent = JSON.stringify({
        protocolVersion: state.protocol ? state.protocol.protocolVersion : null,
        stableMethods: methods.filter((method) => method.stability === 'stable').map((method) => method.method),
        experimentalMethods: methods.filter((method) => method.stability === 'experimental').map((method) => method.method),
        debugOnlyMethods: methods.filter((method) => method.stability === 'debug-only').map((method) => method.method)
      });
    }

    function renderWorkspace() {
      if (state.tab === 'approvals') {
        renderApprovals();
        return;
      }
      if (state.tab === 'review') {
        renderReview();
        return;
      }
      renderTranscript();
    }

    function appendLiveEvent(event) {
      if (!event || !event.type || !eventScopeMatches(event)) return;
      state.liveRuntimeState = reduceLiveRuntimeEvent(state.liveRuntimeState, event);
      state.liveEvents = [{
        id: event.type + ':' + Date.now() + ':' + Math.random().toString(36).slice(2),
        at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        event
      }].concat(state.liveEvents).slice(0, 40);
      renderLiveEvents();
      if (state.tab === 'transcript') renderTranscript();
    }

    function eventScopeMatches(event) {
      if (event.projectId && state.project && event.projectId !== state.project.id) return false;
      if (event.threadId && state.thread && event.threadId !== state.thread.id) return false;
      return true;
    }

    function renderLiveEvents() {
      const node = el('liveEventStream');
      if (!node) return;
      if (state.liveEvents.length === 0) {
        node.className = 'live-events empty';
        node.textContent = 'Waiting for runtime events';
        return;
      }
      node.className = 'live-events';
      node.innerHTML = '<div class="live-event-list">' + state.liveEvents.slice(0, 8).map(renderLiveEvent).join('') + '</div>';
    }

    function renderLiveEvent(item) {
      const event = item.event;
      return '<div class="live-event">' +
        '<strong>' + escapeHtml(event.type) + '</strong>' +
        '<span>' + escapeHtml(liveEventSummary(event)) + '</span>' +
        '<span>' + escapeHtml(item.at) + '</span>' +
      '</div>';
    }

    function liveEventSummary(event) {
      if (event.type === 'assistant.delta') return event.text || '';
      if (event.type === 'tool.started') return (event.toolName || 'tool') + ' started';
      if (event.type === 'tool.delta') return (event.toolName || 'tool') + ' · ' + (event.delta || event.totalLines + ' lines');
      if (event.type === 'tool.completed') return (event.toolName || 'tool') + (event.isError ? ' failed' : ' completed');
      if (event.type === 'turn.started') return 'turn ' + event.turnIndex + ' started';
      if (event.type === 'turn.completed') return event.stopReason || 'turn completed';
      if (event.type === 'turn.failed') return event.message || 'turn failed';
      if (event.type === 'turn.interrupted') return event.reason || event.status || 'interrupted';
      if (event.type === 'approval.requested') return (event.toolName || 'tool') + ' waiting for approval';
      if (event.type === 'approval.resolved') return (event.toolName || 'tool') + ' ' + event.status;
      if (event.type === 'interaction.requested') return event.kind + ' waiting';
      if (event.type === 'interaction.resolved') return event.kind + ' ' + event.status;
      if (event.type === 'review.batchCompleted') return event.action + ' ' + event.status + ' · ' + (event.diffIds || []).length + ' changes';
      if (event.type === 'thread.updated') return 'thread updated · ' + event.turnCount + ' turns';
      if (event.type === 'runtimeRail.updated') return event.freshness || event.source || 'rail updated';
      return event.threadId || event.projectId || event.type;
    }

    function renderTranscript() {
      if (!state.thread) {
        el('workspaceSurface').innerHTML = '<div class="empty">Select or create a thread</div>';
        return;
      }
      const items = state.transcript ? state.transcript.items || [] : [];
      const liveItems = state.liveRuntimeState.items || [];
      if (items.length === 0 && liveItems.length === 0) {
        el('workspaceSurface').innerHTML = '<div class="empty">Empty transcript</div>';
        return;
      }
      el('workspaceSurface').innerHTML = '<div class="timeline">' +
        items.map(renderTranscriptItem).join('') +
        liveItems.map(renderLiveRuntimeItem).join('') +
      '</div>';
    }

    function renderTranscriptItem(item) {
      if (item.kind === 'tool_call') {
        const status = item.status || 'pending';
        return '<article class="item tool ' + escapeHtml(status) + '">' +
          '<div class="item-head"><strong>' + escapeHtml(item.toolName) + '</strong><span class="status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span></div>' +
          '<div class="split"><pre class="mono">' + escapeHtml(jsonPreview(item.input)) + '</pre><pre class="mono">' + escapeHtml(item.result ? item.result.content : 'pending') + '</pre></div>' +
          '<div class="meta"><span>' + escapeHtml(item.toolUseId) + '</span><span>' + escapeHtml(item.runtime && item.runtime.turnId ? item.runtime.turnId : '') + '</span></div>' +
        '</article>';
      }
      if (item.kind === 'thinking') {
        return '<article class="item assistant"><div class="item-head"><strong>thinking</strong></div><div class="text">' + escapeHtml(item.text) + '</div></article>';
      }
      return '<article class="item ' + escapeHtml(item.role) + '">' +
        '<div class="item-head"><strong>' + escapeHtml(item.role) + '</strong><span class="row-sub">turn ' + escapeHtml(item.turnIndex) + '</span></div>' +
        '<div class="text">' + escapeHtml(item.text) + '</div>' +
      '</article>';
    }

    function renderLiveRuntimeItem(item) {
      if (item.kind === 'tool') {
        return '<article class="item tool live ' + escapeHtml(item.status) + '" data-surface="live-runtime-item">' +
          '<div class="item-head"><strong>' + escapeHtml(item.toolName || 'tool') + '</strong><span class="status ' + escapeHtml(item.status) + '">' + escapeHtml(item.status) + '</span></div>' +
          '<div class="split"><pre class="mono">' + escapeHtml(jsonPreview(item.input)) + '</pre><pre class="mono" data-surface="tool-output-delta">' + escapeHtml(item.result || item.output || 'running') + '</pre></div>' +
          '<div class="meta"><span>live</span><span>' + escapeHtml(item.toolUseId || item.itemId || '') + '</span><span>' + escapeHtml(item.runtimeTurnId || '') + '</span><span>' + escapeHtml(item.totalLines == null ? '' : item.totalLines + ' lines') + '</span></div>' +
        '</article>';
      }
      return '<article class="item assistant live ' + escapeHtml(item.status) + '" data-surface="live-runtime-item">' +
        '<div class="item-head"><strong>assistant live</strong><span class="status ' + escapeHtml(item.status) + '">' + escapeHtml(item.status) + '</span></div>' +
        '<div class="text">' + escapeHtml(item.text || '') + '</div>' +
        '<div class="meta"><span>live</span><span>turn ' + escapeHtml(item.turnIndex == null ? 'current' : item.turnIndex) + '</span></div>' +
      '</article>';
    }

    function renderApprovals() {
      if (!state.thread) {
        el('workspaceSurface').innerHTML = '<div class="empty" data-surface="approval-center">Select or create a thread</div>';
        return;
      }
      const interactions = state.interactions
        ? state.interactions.interactions || []
        : (state.approvals ? state.approvals.approvals || [] : []);
      if (interactions.length === 0) {
        el('workspaceSurface').innerHTML = '<div class="empty" data-surface="approval-center">No pending interactions</div>';
        return;
      }
      el('workspaceSurface').innerHTML = '<div class="review-list" data-surface="approval-center interaction-center">' +
        '<div data-surface="interaction-center"></div>' +
        interactions.map(renderInteractionItem).join('') +
      '</div>';
      document.querySelectorAll('[data-interaction-id][data-interaction-decision]').forEach((node) => {
        node.addEventListener('click', () => {
          void respondInteraction(node.getAttribute('data-interaction-id'), {
            decision: node.getAttribute('data-interaction-decision')
          });
        });
      });
      document.querySelectorAll('[data-interaction-answer]').forEach((node) => {
        node.addEventListener('click', () => {
          const interactionId = node.getAttribute('data-interaction-answer');
          const input = document.querySelector('[data-interaction-input="' + interactionId + '"]');
          void respondInteraction(interactionId, {
            answer: input ? input.value : ''
          });
        });
      });
    }

    function renderInteractionItem(approval) {
      const kind = approval.kind || 'tool_approval';
      if (kind === 'user_question') return renderUserQuestionItem(approval);
      const taskScope = approval.taskScope || {};
      return '<article class="item tool">' +
        '<div class="item-head"><strong>' + escapeHtml(approval.toolName || kind || 'tool') + '</strong><span class="status ' + escapeHtml(approval.status) + '">' + escapeHtml(approval.status) + '</span></div>' +
        '<div class="meta"><span>' + escapeHtml(kind) + '</span><span>' + escapeHtml(approval.source || 'live') + '</span></div>' +
        '<pre class="mono">' + escapeHtml(jsonPreview(approval.input)) + '</pre>' +
        (taskScope.message ? '<div class="row-sub">' + escapeHtml(taskScope.message) + '</div>' : '') +
        '<div class="meta"><span>' + escapeHtml(approval.id) + '</span><span>' + escapeHtml(new Date(approval.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })) + '</span></div>' +
        '<div class="approval-actions"><button class="primary" data-interaction-id="' + escapeHtml(approval.id) + '" data-interaction-decision="approve">Approve</button><button data-interaction-id="' + escapeHtml(approval.id) + '" data-interaction-decision="deny">Deny</button></div>' +
      '</article>';
    }

    function renderUserQuestionItem(interaction) {
      const options = interaction.options || [];
      return '<article class="item tool">' +
        '<div class="item-head"><strong>' + escapeHtml(interaction.toolName || 'AskUserQuestion') + '</strong><span class="status ' + escapeHtml(interaction.status) + '">' + escapeHtml(interaction.status) + '</span></div>' +
        '<div class="text">' + escapeHtml(interaction.question || '') + '</div>' +
        (options.length ? '<div class="meta">' + options.map((option) => '<span>' + escapeHtml(option.label) + '</span>').join('') + '</div>' : '') +
        '<textarea data-interaction-input="' + escapeHtml(interaction.id) + '" placeholder="Answer"></textarea>' +
        '<div class="meta"><span>' + escapeHtml(interaction.id) + '</span><span>' + escapeHtml(interaction.source || 'live') + '</span></div>' +
        '<div class="approval-actions"><button class="primary" data-interaction-answer="' + escapeHtml(interaction.id) + '">Answer</button><button data-interaction-id="' + escapeHtml(interaction.id) + '" data-interaction-decision="deny">Cancel</button></div>' +
      '</article>';
    }

    async function respondInteraction(interactionId, response) {
      if (!interactionId || !state.project || !state.thread) return;
      try {
        await rpc('interaction/respond', {
          interactionId,
          ...(response.decision ? { decision: response.decision } : {}),
          ...(response.answer != null ? { answer: response.answer } : {})
        });
        await loadThreadSurfaces();
        render();
      } catch (error) {
        showToast(error.message || 'Interaction failed');
        await loadThreadSurfaces();
        render();
      }
    }

    function createLiveRuntimeState() {
      return { activeTurnIndex: undefined, items: [] };
    }

    function resetLiveRuntimeState() {
      state.liveRuntimeState = createLiveRuntimeState();
      state.liveEvents = [];
    }

    function reduceLiveRuntimeEvent(runtimeState, event) {
      if (!liveEventInCurrentScope(event)) return runtimeState;
      if (event.type === 'turn.started') {
        return { ...runtimeState, activeTurnIndex: event.turnIndex };
      }
      if (event.type === 'assistant.delta') {
        const turnIndex = runtimeState.activeTurnIndex;
        const id = liveAssistantItemId(event.threadId, turnIndex);
        const existing = runtimeState.items.find((item) => item.id === id);
        const item = existing && existing.kind === 'assistant'
          ? { ...existing, status: 'streaming', text: existing.text + (event.text || '') }
          : {
              id,
              kind: 'assistant',
              status: 'streaming',
              text: event.text || '',
              projectId: event.projectId,
              threadId: event.threadId,
              turnIndex
            };
        return upsertLiveRuntimeItem(runtimeState, item);
      }
      if (event.type === 'tool.started') {
        const id = liveToolItemId(event);
        const existing = runtimeState.items.find((item) => item.id === id);
        const item = existing && existing.kind === 'tool'
          ? {
              ...existing,
              status: 'running',
              toolName: event.toolName,
              input: event.input || {},
              toolUseId: event.toolUseId,
              itemId: event.itemId,
              runtimeTurnId: event.runtimeTurnId
            }
          : {
              id,
              kind: 'tool',
              status: 'running',
              toolName: event.toolName,
              input: event.input || {},
              projectId: event.projectId,
              threadId: event.threadId,
              toolUseId: event.toolUseId,
              itemId: event.itemId,
              runtimeTurnId: event.runtimeTurnId
            };
        return upsertLiveRuntimeItem(runtimeState, item);
      }
      if (event.type === 'tool.delta') {
        const id = liveToolItemId(event);
        const existing = runtimeState.items.find((item) => item.id === id);
        const output = appendToolOutputDelta(existing && existing.kind === 'tool' ? existing.output : '', event.delta || '');
        const item = existing && existing.kind === 'tool'
          ? {
              ...existing,
              status: 'running',
              toolName: event.toolName,
              output,
              totalLines: event.totalLines,
              totalBytes: event.totalBytes,
              elapsedMs: event.elapsedMs,
              toolUseId: event.toolUseId,
              itemId: event.itemId,
              runtimeTurnId: event.runtimeTurnId
            }
          : {
              id,
              kind: 'tool',
              status: 'running',
              toolName: event.toolName,
              input: {},
              output,
              projectId: event.projectId,
              threadId: event.threadId,
              totalLines: event.totalLines,
              totalBytes: event.totalBytes,
              elapsedMs: event.elapsedMs,
              toolUseId: event.toolUseId,
              itemId: event.itemId,
              runtimeTurnId: event.runtimeTurnId
            };
        return upsertLiveRuntimeItem(runtimeState, item);
      }
      if (event.type === 'tool.completed') {
        const id = liveToolItemId(event);
        const existing = runtimeState.items.find((item) => item.id === id);
        const item = existing && existing.kind === 'tool'
          ? {
              ...existing,
              status: event.isError ? 'failed' : 'completed',
              toolName: event.toolName,
              result: event.result,
              isError: event.isError,
              durationMs: event.durationMs,
              toolUseId: event.toolUseId,
              itemId: event.itemId,
              runtimeTurnId: event.runtimeTurnId
            }
          : {
              id,
              kind: 'tool',
              status: event.isError ? 'failed' : 'completed',
              toolName: event.toolName,
              input: {},
              projectId: event.projectId,
              threadId: event.threadId,
              result: event.result,
              isError: event.isError,
              durationMs: event.durationMs,
              toolUseId: event.toolUseId,
              itemId: event.itemId,
              runtimeTurnId: event.runtimeTurnId
            };
        return upsertLiveRuntimeItem(runtimeState, item);
      }
      if (event.type === 'turn.completed') {
        return {
          ...runtimeState,
          items: runtimeState.items.map((item) => {
            if (item.threadId !== event.threadId) return item;
            if (item.kind === 'assistant' && item.status === 'streaming') {
              return { ...item, status: 'completed', text: item.text || event.finalText || '' };
            }
            return item;
          })
        };
      }
      if (event.type === 'turn.failed' || event.type === 'turn.interrupted') {
        return {
          ...runtimeState,
          items: runtimeState.items.map((item) => {
            if (item.threadId !== event.threadId) return item;
            if (item.kind === 'tool') return { ...item, status: 'failed' };
            return { ...item, status: event.type === 'turn.failed' ? 'failed' : 'interrupted' };
          })
        };
      }
      return runtimeState;
    }

    function liveEventInCurrentScope(event) {
      if (!event || !state.project || event.projectId !== state.project.id) return false;
      if ('threadId' in event && (!state.thread || event.threadId !== state.thread.id)) return false;
      return true;
    }

    function liveAssistantItemId(threadId, turnIndex) {
      return 'live-assistant:' + threadId + ':' + (turnIndex == null ? 'current' : turnIndex);
    }

    function liveToolItemId(event) {
      return 'live-tool:' + (event.itemId || event.toolUseId || event.toolName || 'tool');
    }

    function appendToolOutputDelta(output, delta) {
      if (!delta) return output || '';
      if (!output) return delta;
      return output + '\\n' + delta;
    }

    function upsertLiveRuntimeItem(runtimeState, item) {
      const index = runtimeState.items.findIndex((current) => current.id === item.id);
      if (index === -1) return { ...runtimeState, items: runtimeState.items.concat(item) };
      return {
        ...runtimeState,
        items: runtimeState.items.slice(0, index).concat(item, runtimeState.items.slice(index + 1))
      };
    }

    function renderReview() {
      if (!state.thread) {
        el('workspaceSurface').innerHTML = '<div class="empty">Select or create a thread</div>';
        return;
      }
      const changes = state.review ? state.review.changes || [] : [];
      if (changes.length === 0) {
        el('workspaceSurface').innerHTML = '<div class="empty">No review items</div>';
        return;
      }
      const preflights = new Map(((state.review.preflight && state.review.preflight.preflights) || []).map((item) => [item.change.id, item]));
      el('workspaceSurface').innerHTML =
        '<div class="review-actions"><button id="applyAll" class="primary">Apply</button><button id="revertAll">Revert</button></div>' +
        '<div class="review-list">' + changes.map((change) => renderReviewItem(change, preflights.get(change.id))).join('') + '</div>';
      el('applyAll').addEventListener('click', () => mutateReview('review/batchApply'));
      el('revertAll').addEventListener('click', () => mutateReview('review/batchRevert'));
      Array.from(document.querySelectorAll('[data-review-hunk-method]')).forEach((button) => {
        button.addEventListener('click', () => mutateReviewHunk(
          button.getAttribute('data-review-hunk-method'),
          button.getAttribute('data-review-diff-id'),
          button.getAttribute('data-review-hunk-id')
        ));
      });
    }

    function renderReviewItem(change, preflight) {
      const status = preflight ? preflight.status : 'blocked';
      const reason = preflight ? preflight.reason : 'missing_preflight';
      return '<article class="item">' +
        '<div class="item-head"><strong>' + escapeHtml(shortPath(change.path)) + '</strong><span class="status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span></div>' +
        '<div class="meta"><span>' + escapeHtml(change.toolName) + '</span><span>' + escapeHtml(change.operation) + '</span><span>' + escapeHtml(reason) + '</span></div>' +
        renderBashProvenance(change) +
        renderReviewHunks(change) +
        '<pre class="mono">' + escapeHtml(change.diffPreview || '') + '</pre>' +
      '</article>';
    }

    function renderBashProvenance(change) {
      const provenance = change.bashProvenance;
      if (!provenance) return '';
      const refs = Array.isArray(provenance.sourceRefs) ? provenance.sourceRefs : [];
      return '<div class="hunk-list" data-surface="bash-source-capture">' +
        '<div class="meta"><span>' + escapeHtml(provenance.sourceCaptureStatus || 'unknown') + '</span><span>' + escapeHtml(provenance.commandRef || '') + '</span><span>' + escapeHtml(provenance.statusRef || '') + '</span><span>' + escapeHtml(provenance.outputRef || '') + '</span></div>' +
        refs.map((ref) =>
          '<div class="row-sub">' + escapeHtml([
            ref.captureStatus,
            ref.kind,
            ref.sourceRef,
            shortPath(ref.path)
          ].filter(Boolean).join(' · ')) + '</div>'
        ).join('') +
      '</div>';
    }

    function renderReviewHunks(change) {
      const hunks = Array.isArray(change.hunks) ? change.hunks : [];
      if (hunks.length === 0) return '';
      return '<div class="hunk-list">' + hunks.map((hunk) =>
        '<div class="hunk-row">' +
          '<code class="mono">' + escapeHtml(hunk.hunkId) + ': ' + escapeHtml(hunk.oldText || '') + ' -> ' + escapeHtml(hunk.newText || '') + '</code>' +
          '<div class="hunk-actions">' +
            '<button data-review-hunk-method="review/hunkApply" data-review-diff-id="' + escapeHtml(change.id) + '" data-review-hunk-id="' + escapeHtml(hunk.hunkId) + '">Apply hunk</button>' +
            '<button data-review-hunk-method="review/hunkRevert" data-review-diff-id="' + escapeHtml(change.id) + '" data-review-hunk-id="' + escapeHtml(hunk.hunkId) + '">Revert hunk</button>' +
          '</div>' +
        '</div>'
      ).join('') + '</div>';
    }

    async function mutateReview(method) {
      if (!state.project || !state.thread || !state.review) return;
      const diffIds = (state.review.changes || []).map((change) => change.id);
      if (diffIds.length === 0) return;
      try {
        await rpc(method, { projectId: state.project.id, threadId: state.thread.id, diffIds });
        await loadThreadSurfaces();
        render();
      } catch (error) {
        showToast(error.message || 'Review blocked');
        await loadThreadSurfaces();
        render();
      }
    }

    async function mutateReviewHunk(method, diffId, hunkId) {
      if (!state.project || !state.thread || !method || !diffId || !hunkId) return;
      try {
        await rpc(method, { projectId: state.project.id, threadId: state.thread.id, diffId, hunkId });
        await loadThreadSurfaces();
        render();
      } catch (error) {
        showToast(error.message || 'Review hunk blocked');
        await loadThreadSurfaces();
        render();
      }
    }

    function renderRail() {
      const rail = state.rail;
      el('railFreshness').textContent = rail ? rail.freshness : 'missing';
      if (!rail) {
        el('railSurface').innerHTML = '<div class="empty">No rail</div>';
        return;
      }
      const summary = rail.summary;
      const current = summary && summary.currentExecution ? summary.currentExecution : {};
      const closeout = summary && summary.latestIndexedCloseout ? summary.latestIndexedCloseout : null;
      const source = summary && summary.source ? summary.source : {};
      const leases = summary && summary.leases ? summary.leases : { activeCount: 0, holders: [] };
      const evidence = summary && summary.evidence ? summary.evidence : {};
      const resourcePreflight = summary && summary.resourcePreflight ? summary.resourcePreflight : null;
      const gap = summary && summary.dominantGap ? summary.dominantGap : {};
      const leaseHolders = (leases.holders || []).map((holder) => holder.runId + '/' + holder.workItemId);
      el('railSurface').innerHTML =
        '<section class="rail-block" data-surface="runkit-context-summary"><h3>RunKit</h3><div class="rail-list">' +
          '<div class="row-sub">' + escapeHtml(rail.projectId) + ' · ' + escapeHtml(rail.source) + '</div>' +
          '<div class="status ' + escapeHtml(rail.freshness) + '">' + escapeHtml(rail.freshness) + '</div>' +
          (rail.error ? '<div class="row-sub">' + escapeHtml(rail.error) + '</div>' : '') +
        '</div></section>' +
        '<section class="rail-block"><h3>Current execution</h3><div class="rail-list">' +
          '<div class="row-title">' + escapeHtml(current.selectedRunId || 'none') + '</div>' +
          '<div class="row-sub">' + escapeHtml((current.state || 'not_connected') + ' · open ' + (current.openCount || 0)) + '</div>' +
          '<div class="row-sub">' + escapeHtml((current.activeRunIds || []).join(', ') || 'no active executions') + '</div>' +
        '</div></section>' +
        '<section class="rail-block"><h3>Latest closeout</h3><div class="rail-list">' +
          '<div class="row-title">' + escapeHtml(closeout ? closeout.runId : 'none') + '</div>' +
          '<div class="row-sub">' + escapeHtml(closeout ? closeout.decision + ' · ' + closeout.trustLevel : 'none') + '</div>' +
        '</div></section>' +
        '<section class="rail-block"><h3>Source and leases</h3><div class="rail-list">' +
          '<div class="row-title">' + escapeHtml(source.status || 'none') + '</div>' +
          '<div class="row-sub">' + escapeHtml(source.sourceFingerprint || 'no fingerprint') + '</div>' +
          '<div class="row-sub">Active leases: ' + escapeHtml(leases.activeCount || 0) + '</div>' +
          '<div class="row-sub">' + escapeHtml(leaseHolders.length ? leaseHolders.join(', ') : 'no lease holders') + '</div>' +
        '</div></section>' +
        '<section class="rail-block"><h3>Evidence</h3><div class="rail-list">' +
          '<div class="row-title">' + escapeHtml(evidence.status || 'none') + '</div>' +
          '<div class="row-sub">' + escapeHtml([evidence.decision, evidence.trustLevel].filter(Boolean).join(' · ') || 'none') + '</div>' +
          '<div class="row-sub">' + escapeHtml(evidence.activeReceiptSha256 || 'no active receipt') + '</div>' +
        '</div></section>' +
        '<section class="rail-block" data-surface="runkit-resource-preflight"><h3>Model resources</h3>' + renderResourcePreflight(resourcePreflight) + '</section>' +
        '<section class="rail-block"><h3>Dominant gap</h3><div class="rail-list">' +
          '<div class="row-title">' + escapeHtml(gap.code || 'connect_runkit') + '</div>' +
          '<div class="row-sub">' + escapeHtml((gap.reasons || []).join(' · ') || 'none') + '</div>' +
        '</div></section>' +
        '<section class="rail-block"><h3>Next allowed action</h3><div class="rail-list">' +
          '<div class="row-title">' + escapeHtml(summary ? summary.nextAllowedAction : (rail.repairAction || 'connect_runkit')) + '</div>' +
          '<div class="row-sub">Git authorization: ' + escapeHtml(summary ? summary.gitAuthorization : false) + '</div>' +
          '<div class="row-sub">Release authorization: ' + escapeHtml(summary ? summary.releaseAuthorization : false) + '</div>' +
        '</div></section>' +
        '<section class="rail-block" data-surface="runtime-facts-summary"><h3>Runtime Facts</h3>' + renderRuntimeFactsSummary(state.runtimeFacts) + '</section>' +
        '<section class="rail-block" data-surface="structured-output-artifacts"><h3>Structured Output</h3>' + renderStructuredOutputArtifacts(state.structuredOutputArtifacts) + '</section>' +
        '<section class="rail-block" data-surface="model-comparison-panel"><h3>Model Comparison</h3>' + renderModelComparisonPanel(state.providerEvalReport) + '</section>' +
        '<section class="rail-block" data-surface="provider-eval-report"><h3>Provider Eval</h3>' + renderProviderEvalReport(state.providerEvalReport) + '</section>';
    }

    function renderResourcePreflight(preflight) {
      if (!preflight || preflight.status === 'none') {
        return '<div class="rail-list"><div class="row-title">not evaluated</div><div class="row-sub">RunKit has no model resource preflight for this execution.</div></div>';
      }
      const estimate = preflight.estimate || {};
      const cost = estimate.cost || {};
      const costLabel = cost.status === 'known'
        ? '$' + Number(cost.valueUsd || 0).toFixed(4)
        : '$' + Number(cost.knownSubtotalUsd || 0).toFixed(4) + ' known + unknown';
      const resources = (preflight.resources || []).map((resource) => {
        const quota = resource.quota || {};
        const demand = resource.demand || {};
        return '<div class="rail-list">' +
          '<div class="row-title">' + escapeHtml(resource.providerId + '/' + resource.modelId) + '</div>' +
          '<div class="row-sub">availability: ' + escapeHtml(resource.availability && resource.availability.status || 'unknown') + '</div>' +
          '<div class="row-sub">remaining calls: ' + escapeHtml(renderTypedResourceValue(quota.remainingCalls)) + '</div>' +
          '<div class="row-sub">remaining tokens: ' + escapeHtml(renderTypedResourceValue(quota.remainingTokens)) + '</div>' +
          '<div class="row-sub">reset: ' + escapeHtml(renderTypedResourceValue(quota.resetAt)) + '</div>' +
          '<div class="row-sub">demand: ' + escapeHtml((demand.calls || 0) + ' calls · ' + (demand.totalTokens || 0) + ' tokens') + '</div>' +
        '</div>';
      }).join('');
      return '<div class="rail-list">' +
        '<div class="row-title">' + escapeHtml(preflight.status + (preflight.decision ? ' · ' + preflight.decision : '')) + '</div>' +
        '<div class="row-sub">' + escapeHtml(preflight.preflightId || 'no preflight id') + '</div>' +
        '<div class="row-sub">estimate: ' + escapeHtml((estimate.calls || 0) + ' calls · ' + (estimate.totalTokens || 0) + ' tokens · ' + (estimate.elapsedMs || 0) + ' ms · ' + costLabel) + '</div>' +
        '<div class="row-sub">receipt reuse: ' + escapeHtml((preflight.receiptReuse && preflight.receiptReuse.appliedCount || 0) + '/' + (preflight.receiptReuse && preflight.receiptReuse.reusableCount || 0)) + '</div>' +
        '<div class="row-sub">valid until: ' + escapeHtml(preflight.validUntil || 'not declared') + '</div>' +
        (preflight.blockers || []).map((item) => '<div class="row-sub">blocked: ' + escapeHtml(item) + '</div>').join('') +
        (preflight.warnings || []).map((item) => '<div class="row-sub">warning: ' + escapeHtml(item) + '</div>').join('') +
        resources +
      '</div>';
    }

    function renderTypedResourceValue(value) {
      if (!value) return 'unknown';
      if (value.status === 'known') return String(value.value);
      return 'unknown' + (value.reason ? ' (' + value.reason + ')' : '');
    }

    function latestRunIdFromTranscript(transcript) {
      const items = transcript && Array.isArray(transcript.items) ? transcript.items : [];
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const runId = items[index] && items[index].runtime ? items[index].runtime.runId : null;
        if (runId) return runId;
      }
      return null;
    }

    function renderRuntimeFactsSummary(facts) {
      if (!facts) return '<div class="row-sub">select a thread</div>';
      if (facts.unavailable) return '<div class="row-sub">' + escapeHtml(facts.message || 'runtime facts unavailable') + '</div>';
      return '<div class="rail-list">' +
        '<div class="row-sub">run=' + escapeHtml(facts.runId || '') + '</div>' +
        '<div class="meta">' +
          '<span>events ' + escapeHtml(facts.runtimeEventCount || 0) + '</span>' +
          '<span>checkpoints ' + escapeHtml(facts.checkpointCount || 0) + '</span>' +
          '<span>jobs ' + escapeHtml(facts.jobCount || 0) + '</span>' +
          '<span>artifacts ' + escapeHtml(facts.artifactCount || 0) + '</span>' +
        '</div>' +
        '<div class="row-sub">' + escapeHtml([
          (facts.taskIds || []).length + ' tasks',
          (facts.proofIds || []).length + ' proofs',
          (facts.jobIds || []).length + ' job refs'
        ].join(' · ')) + '</div>' +
      '</div>';
    }

    function renderStructuredOutputArtifacts(result) {
      if (!result) return '<div class="row-sub">loading</div>';
      if (result.unavailable) return '<div class="row-sub">' + escapeHtml(result.message || 'structured output unavailable') + '</div>';
      const items = result.items || [];
      const renderedItems = items.slice(0, 4).map((item) => (
        '<div class="item ' + escapeHtml(item.status || '') + '" style="padding:8px;">' +
          '<div class="item-head"><strong>' + escapeHtml(item.role || item.artifactId || 'artifact') + '</strong><span class="status ' + escapeHtml(item.status || '') + '">' + escapeHtml(item.status || 'unknown') + '</span></div>' +
          '<div class="row-sub">' + escapeHtml([
            item.preset,
            item.model,
            item.schemaValid === true ? 'schema ok' : item.schemaValid === false ? 'schema failed' : 'schema unknown',
            item.fallbackUsed ? 'fallback' : null,
            item.rerunAction && item.rerunAction.available ? 'rerun ready' : 'rerun unavailable'
          ].filter(Boolean).join(' · ')) + '</div>' +
          '<div class="row-sub">' + escapeHtml((item.attempts || []).length + ' attempts · ' + (item.validationErrors || []).length + ' validation errors') + '</div>' +
        '</div>'
      )).join('');
      return '<div class="rail-list">' +
        '<div class="row-sub">' + escapeHtml([
          (result.successCount || 0) + ' success',
          (result.warningCount || 0) + ' warning',
          (result.failedCount || 0) + ' failed'
        ].join(' · ')) + '</div>' +
        (renderedItems || '<div class="row-sub">no structured output artifacts</div>') +
      '</div>';
    }

    function renderProviderEvalReport(result) {
      return renderModelComparisonPanel(result);
    }

    function renderModelComparisonPanel(result) {
      if (!result) return '<div class="row-sub">loading</div>';
      if (result.unavailable) return '<div class="row-sub">' + escapeHtml(result.message || 'unavailable') + '</div>';
      const report = result.report || {};
      const leaderboard = report.leaderboard || [];
      const caseMatrix = report.caseMatrix || [];
      const summary = report.summary || (result.recordCount + ' records');
      const items = leaderboard.slice(0, 4).map((item) => (
        '<div class="item" style="padding:8px;">' +
          '<div class="row-title">' + escapeHtml(item.providerId + '/' + item.modelId) + '</div>' +
          '<div class="row-sub">' + escapeHtml([
            item.passedCount + '/' + item.runCount + ' pass',
            Math.round((item.passRate || 0) * 100) + '%',
            'score ' + item.averageScore,
            item.verdict
          ].join(' · ')) + '</div>' +
        '</div>'
      )).join('');
      const cases = caseMatrix.slice(0, 6).map((item) => (
        '<div class="item ' + escapeHtml(item.passed ? 'completed' : 'failed') + '" style="padding:8px;">' +
          '<div class="row-title">' + escapeHtml(item.caseId || 'case') + '</div>' +
          '<div class="row-sub">' + escapeHtml([
            (item.providerId || '') + '/' + (item.modelId || ''),
            item.passed ? 'pass' : 'fail',
            'score ' + item.score,
            item.antiCheat ? 'anti-cheat ' + item.antiCheat : null,
            item.error || null
          ].filter(Boolean).join(' · ')) + '</div>' +
        '</div>'
      )).join('');
      return '<div class="rail-list">' +
        '<div class="row-sub">' + escapeHtml(summary) + '</div>' +
        '<div class="row-sub">local_only=' + escapeHtml(String(report.localOnly === true)) + ' · training=' + escapeHtml(report.trainingUse || 'not_collected') + '</div>' +
        '<div class="row-sub">Leaderboard</div>' +
        (items || '<div class="row-sub">no provider eval records</div>') +
        '<div class="row-sub">Case matrix</div>' +
        (cases || '<div class="row-sub">no case matrix records</div>') +
      '</div>';
    }

    async function createThread() {
      if (!state.project) return;
      const suffix = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const result = await rpc('thread/start', {
        projectId: state.project.id,
        title: 'Desktop thread ' + suffix,
        model: 'app-server-unselected'
      });
      state.thread = result.thread;
      resetLiveRuntimeState();
      await refreshShell();
    }

    async function sendTurn() {
      const input = el('composerInput').value.trim();
      if (!input || !state.project || !state.thread) return;
      el('composerInput').value = '';
      resetLiveRuntimeState();
      render();
      try {
        await rpc('turn/start', { projectId: state.project.id, threadId: state.thread.id, input });
        await refreshShell();
      } catch (error) {
        showToast(error.message || 'Turn failed');
        await refreshShell();
      }
    }

    function showToast(message) {
      const node = el('toast');
      node.textContent = message;
      node.className = 'toast show';
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(() => { node.className = 'toast'; }, 3600);
    }

    el('refreshShell').addEventListener('click', refreshShell);
    el('newThread').addEventListener('click', createThread);
    el('sendTurn').addEventListener('click', sendTurn);
    el('tabTranscript').addEventListener('click', () => { state.tab = 'transcript'; render(); });
    el('tabApprovals').addEventListener('click', () => { state.tab = 'approvals'; render(); });
    el('tabReview').addEventListener('click', () => { state.tab = 'review'; render(); });
    el('composerInput').addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') sendTurn();
    });
    try {
      const events = new EventSource(appServerUrl + '/events');
      events.addEventListener('turn.started', (event) => handleLiveServerEvent(event, { refresh: false }));
      events.addEventListener('assistant.delta', (event) => handleLiveServerEvent(event, { refresh: false }));
      events.addEventListener('tool.started', (event) => handleLiveServerEvent(event, { refresh: false }));
      events.addEventListener('tool.delta', (event) => handleLiveServerEvent(event, { refresh: false }));
      events.addEventListener('tool.completed', (event) => handleLiveServerEvent(event, { refresh: false }));
      events.addEventListener('turn.interrupted', (event) => handleLiveServerEvent(event, { refresh: true }));
      events.addEventListener('thread.updated', (event) => handleLiveServerEvent(event, { refresh: true }));
      events.addEventListener('approval.requested', (event) => handleLiveServerEvent(event, { refresh: true }));
      events.addEventListener('approval.resolved', (event) => handleLiveServerEvent(event, { refresh: true }));
      events.addEventListener('interaction.requested', (event) => handleLiveServerEvent(event, { refresh: true }));
      events.addEventListener('interaction.resolved', (event) => handleLiveServerEvent(event, { refresh: true }));
      events.addEventListener('review.batchCompleted', (event) => handleLiveServerEvent(event, { refresh: true }));
      events.addEventListener('turn.completed', (event) => handleLiveServerEvent(event, { refresh: true }));
      events.addEventListener('turn.failed', (event) => handleLiveServerEvent(event, { refresh: true }));
      events.addEventListener('runtimeRail.updated', (event) => handleLiveServerEvent(event, { refresh: true }));
    } catch {}
    refreshShell();

    function handleLiveServerEvent(messageEvent, options) {
      const event = parseServerEvent(messageEvent);
      if (!event) return;
      appendLiveEvent(event);
      if (options.refresh) {
        void refreshShell();
      }
    }

    function parseServerEvent(messageEvent) {
      try {
        return JSON.parse(messageEvent.data || '{}');
      } catch {
        return null;
      }
    }
  </script>
</body>
</html>`
}
