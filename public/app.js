const $ = (id) => document.getElementById(id);
const ACTIVE = new Set(['running', 'paused', 'awaiting_input']);
const IN_PROGRESS = new Set(['queued', 'starting', 'running', 'paused', 'awaiting_input', 'saving']);
const FAILURE = new Set(['failed', 'interrupted', 'export_failed']);
const STATE_LABELS = { queued: 'Queued', starting: 'Starting', running: 'Running', awaiting_input: 'Needs input', paused: 'Paused', saving: 'Saving profile', saved: 'Saved', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', export_failed: 'Export failed' };
const state = { authenticated: false, automations: [], runs: [], selectedId: null, collection: 'runs', filter: 'all', query: '', status: null, proxies: [], source: null, interval: null, rfb: null, livePending: false, liveRevision: 0, liveTimeout: null, screenshotUrl: null, screenshotBusy: false, lastSnapshot: 0, snapshotRun: null, challengeId: null, jsonMode: false, actionBusy: false, refreshBusy: false };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function showError(id, message) { $(id).textContent = message || ''; $(id).hidden = !message; }
function messageOf(error) { return error instanceof Error ? error.message : 'The request could not be completed.'; }
function titleFor(run) { return state.automations.find(item => item.id === run.automationId)?.title || run.automationId || 'Automation'; }
function shortId(id) { return String(id || '').slice(0, 8); }
function dateOf(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
function timeOf(value) { return dateOf(value)?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) || '—'; }
function fullDate(value) { return dateOf(value)?.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) || '—'; }
function duration(run) {
  const start = dateOf(run.createdAt)?.getTime();
  const end = IN_PROGRESS.has(run.state) ? Date.now() : dateOf(run.updatedAt)?.getTime();
  if (!start || !end) return '';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
function formatBytes(bytes) { if (!Number.isFinite(bytes)) return 'Size unavailable'; return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
function stateClass(value) { return value === 'saved' ? 'success' : FAILURE.has(value) || value === 'awaiting_input' ? 'warning' : IN_PROGRESS.has(value) ? 'active' : ''; }
function selectedRun() { return state.runs.find(run => run.id === state.selectedId); }
function canInteract(run) { return run && (run.state === 'paused' || run.state === 'awaiting_input' || run.waitingForFinish === true); }
function needsCleanupRecovery(run) { return run.cleanupRequired === true && !IN_PROGRESS.has(run.state); }
function badge(value) { return el('span', `state-badge ${stateClass(value)}`, STATE_LABELS[value] || value); }
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $('toast-region').replaceChildren(el('div', 'toast', message));
  toastTimer = setTimeout(() => $('toast-region').replaceChildren(), 6000);
}

async function api(path, options = {}) {
  const { body, ...rest } = options;
  const response = await fetch(path, { credentials: 'same-origin', ...rest, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...rest.headers } });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try { const data = await response.json(); message = data.error || data.message || message; } catch { /* A gateway may return a non-JSON error. */ }
    if (response.status === 401 && state.authenticated) signOutLocally('Your session expired. Sign in again.');
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

function upsertRun(run) {
  if (!run?.id) return;
  const index = state.runs.findIndex(item => item.id === run.id);
  if (index < 0) state.runs.unshift(run); else state.runs[index] = run;
  state.runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function disconnectLive({ reset = true } = {}) {
  clearTimeout(state.liveTimeout);
  state.liveRevision++;
  state.livePending = false;
  const rfb = state.rfb;
  state.rfb = null;
  if (rfb) { try { rfb.disconnect(); } catch { /* Already disconnected. */ } }
  $('live-screen').replaceChildren();
  $('live-screen').hidden = true;
  $('live-button').textContent = 'Connect live';
  $('live-button').disabled = !ACTIVE.has(selectedRun()?.state);
  $('view-label').textContent = 'Browser snapshot';
  $('view-indicator').classList.remove('live');
  if (reset) {
    $('view-status').textContent = 'Snapshots are still images. Connect live to interact.';
    $('snapshot-button').hidden = false;
    $('browser-snapshot').hidden = !state.screenshotUrl;
    $('browser-placeholder').hidden = Boolean(state.screenshotUrl);
  }
}

function clearSnapshot() {
  if (state.screenshotUrl) URL.revokeObjectURL(state.screenshotUrl);
  state.screenshotUrl = null;
  state.snapshotRun = null;
  state.lastSnapshot = 0;
  $('browser-snapshot').removeAttribute('src');
  $('browser-snapshot').hidden = true;
  $('snapshot-time').textContent = '';
  $('browser-placeholder').hidden = false;
}

function signOutLocally(message = '') {
  state.authenticated = false;
  state.source?.close();
  state.source = null;
  clearInterval(state.interval);
  state.interval = null;
  disconnectLive(); clearSnapshot();
  state.runs = []; state.automations = []; state.proxies = []; state.selectedId = null;
  state.status = null; state.challengeId = null;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('new-run-form').reset(); $('challenge-form').reset(); $('access-token').value = '';
  $('input-fields').replaceChildren(); $('challenge-fields').replaceChildren(); $('json-input').value = '{}';
  $('workspace').hidden = true; $('login-screen').hidden = false;
  $('login-status').textContent = message;
  $('access-token').focus();
}

async function loadWorkspace() {
  state.authenticated = true;
  $('access-token').value = '';
  $('login-screen').hidden = true;
  $('workspace').hidden = false;
  const results = await Promise.allSettled([api('/api/automations'), api('/api/runs'), api('/api/status')]);
  if (!state.authenticated) return;
  if (results[0].status === 'fulfilled') state.automations = Array.isArray(results[0].value) ? results[0].value : [];
  if (results[1].status === 'fulfilled') state.runs = Array.isArray(results[1].value) ? results[1].value : [];
  if (results[2].status === 'fulfilled') state.status = results[2].value;
  const failed = results.find(result => result.status === 'rejected');
  if (failed) toast(messageOf(failed.reason));
  populateAutomations(); renderList(); renderStatus();
  if (state.runs.length) selectRun(state.runs[0].id); else renderDetail();
  openEvents();
  clearInterval(state.interval);
  let tick = 0;
  state.interval = setInterval(() => {
    if (!state.authenticated || document.hidden) return;
    tick++;
    const run = selectedRun();
    if (run) $('detail-duration').textContent = duration(run);
    if (!state.rfb && !state.livePending && ACTIVE.has(run?.state) && Date.now() - state.lastSnapshot > 5000) refreshSnapshot();
    if (tick % 20 === 0) refreshAll(false);
  }, 1000);
}

function openEvents() {
  state.source?.close();
  const source = new EventSource('/api/events'); state.source = source;
  source.onopen = () => { $('connection-status').textContent = 'Updates connected'; };
  source.onerror = () => { $('connection-status').textContent = 'Reconnecting updates…'; };
  source.addEventListener('run', event => {
    if (!state.authenticated) return;
    try {
      const run = JSON.parse(event.data); upsertRun(run); renderList();
      if (run.id === state.selectedId) renderDetail();
    } catch { $('connection-status').textContent = 'Update unavailable'; }
  });
}

async function refreshAll(announce = true) {
  if (state.refreshBusy || !state.authenticated) return;
  state.refreshBusy = true; $('refresh-button').disabled = true;
  try {
    const [runs, status, automations] = await Promise.all([api('/api/runs'), api('/api/status'), api('/api/automations')]);
    if (!state.authenticated) return;
    state.runs = Array.isArray(runs) ? runs : []; state.status = status;
    state.automations = Array.isArray(automations) ? automations : [];
    if (!$('new-run-dialog').open) populateAutomations();
    renderList(); renderStatus(); renderDetail();
    if (announce) toast('Workspace refreshed.');
  } catch (error) { if (announce) toast(messageOf(error)); }
  finally { state.refreshBusy = false; $('refresh-button').disabled = false; }
}

function renderStatus() {
  const engine = state.status?.engine;
  $('engine-label').textContent = engine ? engine.ready ? 'Engine ready' : 'Engine unavailable' : 'Engine status unknown';
  $('engine-dot').className = `status-dot ${engine?.ready ? '' : engine ? 'warning' : 'neutral'}`;
  const capacity = state.status?.config?.maxConcurrency;
  $('capacity-label').textContent = capacity ? `${capacity} concurrent browser${capacity === 1 ? '' : 's'}` : 'Browser capacity unknown';
  const box = $('engine-details'); box.replaceChildren();
  const summary = el('div', 'engine-summary');
  summary.append(el('span', `status-dot ${engine?.ready ? '' : 'warning'}`), el('strong', '', engine?.ready ? 'Ready to start browsers' : 'Engine not available'));
  box.append(summary);
  const facts = el('dl', 'engine-facts');
  appendFact(facts, 'Browser capacity', capacity ? String(capacity) : 'Unknown');
  if (engine?.version) appendFact(facts, 'Engine version', String(engine.version));
  appendFact(facts, 'Runs in progress', String(state.runs.filter(run => IN_PROGRESS.has(run.state)).length));
  appendFact(facts, 'Saved profiles', String(state.runs.filter(run => run.state === 'saved').length));
  box.append(facts);
  if (engine?.error) box.append(el('p', 'form-error', String(engine.error)));
}

function renderList() {
  const runs = state.runs;
  $('all-count').textContent = String(runs.length);
  $('archive-count').textContent = String(runs.filter(run => run.state === 'saved' && run.artifact).length);
  const active = runs.filter(run => IN_PROGRESS.has(run.state)).length;
  $('run-summary').textContent = active ? `${active} run${active === 1 ? '' : 's'} in progress` : runs.length ? `${runs.length} run${runs.length === 1 ? '' : 's'} in your workspace` : 'Ready for your first run';
  const visible = runs.filter(run => {
    if (state.collection === 'archives' && !(run.state === 'saved' && run.artifact)) return false;
    if (state.filter === 'active' && !IN_PROGRESS.has(run.state)) return false;
    if (state.filter === 'attention' && !(run.state === 'awaiting_input' || run.waitingForFinish)) return false;
    if (state.filter === 'saved' && run.state !== 'saved') return false;
    if (state.filter === 'failed' && !FAILURE.has(run.state)) return false;
    return `${titleFor(run)} ${run.id} ${run.automationId}`.toLowerCase().includes(state.query.toLowerCase());
  });
  const focusId = document.activeElement?.closest('.run-row')?.dataset.runId;
  const list = $('run-list'); list.replaceChildren();
  visible.forEach(run => {
    const row = el('button', `run-row${run.id === state.selectedId ? ' selected' : ''}`);
    row.type = 'button'; row.dataset.runId = run.id;
    row.setAttribute('aria-pressed', String(run.id === state.selectedId));
    const top = el('div', 'run-row-top');
    top.append(el('span', 'run-row-title', titleFor(run)));
    const time = el('time', '', fullDate(run.createdAt)); time.dateTime = run.createdAt || ''; top.append(time);
    const bottom = el('div', 'run-row-bottom');
    bottom.append(badge(run.state), el('span', 'run-short-id', run.waitingForFinish ? 'Ready to finish' : shortId(run.id)));
    row.append(top, bottom); row.addEventListener('click', () => selectRun(run.id)); list.append(row);
    if (focusId === run.id) row.focus({ preventScroll: true });
  });
  $('list-empty').hidden = visible.length > 0;
  $('list-empty').textContent = state.query || state.filter !== 'all' ? 'No matching runs. Try a different search or status.' : state.collection === 'archives' ? 'Saved profiles will appear here when a run finishes and its export is verified.' : 'No runs yet. Choose New run to start an automation.';
}

function selectRun(id) {
  const changed = state.selectedId !== id;
  if (changed) { disconnectLive(); clearSnapshot(); state.challengeId = null; }
  state.selectedId = id; renderList(); renderDetail();
  if (changed) refreshSnapshot();
  api(`/api/runs/${encodeURIComponent(id)}`).then(run => { if (!state.authenticated) return; upsertRun(run); if (state.selectedId === id) renderDetail(); }).catch(error => toast(messageOf(error)));
}

function appendFact(list, label, value) { list.append(el('dt', '', label), el('dd', '', value)); }

function renderDetail() {
  const run = selectedRun();
  $('selection-empty').hidden = Boolean(run); $('detail-content').hidden = !run;
  if (!run) return;
  $('detail-title').textContent = titleFor(run);
  $('detail-id').textContent = `Run ${shortId(run.id)}`;
  $('detail-id').title = run.id;
  $('detail-created').textContent = fullDate(run.createdAt);
  $('detail-duration').textContent = duration(run);
  $('detail-state').className = `state-badge ${stateClass(run.state)}`;
  $('detail-state').textContent = run.pauseRequested && run.state !== 'paused' ? 'Pause requested' : STATE_LABELS[run.state] || run.state;
  const cleanupWarning = needsCleanupRecovery(run)
    ? run.profileId
      ? 'Browser shutdown has not been confirmed. New browsers are held until cleanup succeeds. Retry export to stop this browser and recover its profile.'
      : 'Browser cleanup has not been confirmed. New browsers are held until cleanup succeeds. Wait for the pending browser operation to settle, or inspect the engine before recovery.'
    : '';
  showError('run-error', [run.error ? String(run.error) : '', cleanupWarning].filter(Boolean).join(' '));
  renderActions(run); renderChallenge(run); renderActivity(run);
  const facts = $('session-facts'); facts.replaceChildren();
  appendFact(facts, 'Status', STATE_LABELS[run.state] || run.state);
  appendFact(facts, 'Pace', ({ fast: 'Fast', natural: 'Natural', 'natural-fast': 'Natural fast' })[run.preset] || 'Script default');
  if (run.profileId) appendFact(facts, 'Profile', shortId(run.profileId));
  appendFact(facts, 'Updated', timeOf(run.updatedAt));
  const artifact = $('artifact-panel'); artifact.replaceChildren();
  artifact.hidden = !(run.artifact && run.state === 'saved');
  if (!artifact.hidden) {
    artifact.append(el('strong', '', run.artifact.name || 'Saved browser profile'), el('p', '', `${formatBytes(run.artifact.bytes)} · Verified export`));
    const link = el('a', 'button outline small', 'Download .kameleo'); link.href = `/api/runs/${encodeURIComponent(run.id)}/artifact`; link.download = run.artifact.name || 'profile.kameleo'; artifact.append(link);
    if (run.artifact.sha256) { const details = el('details'); details.append(el('summary', '', 'SHA-256 checksum'), el('code', '', run.artifact.sha256)); artifact.append(details); }
  }
  $('save-explanation').textContent = needsCleanupRecovery(run) ? 'Browser capacity remains reserved until shutdown is confirmed. Recovery does not rerun the automation.' : run.state === 'saved' ? 'The profile export is ready to download.' : run.state === 'export_failed' ? 'The run finished, but its profile export needs another attempt.' : run.state === 'interrupted' ? 'The run was interrupted. Retry export to recover its retained profile.' : run.waitingForFinish ? 'Finish when you are done in the browser. The profile will then be saved.' : run.state === 'cancelled' ? 'This run was cancelled. No verified export is available.' : 'A completed run saves its browser profile for reuse.';
  const active = ACTIVE.has(run.state);
  $('snapshot-button').disabled = !active || state.screenshotBusy;
  $('live-button').disabled = !active || state.livePending;
  if (!active && (state.rfb || state.livePending)) disconnectLive();
  if (state.rfb) {
    state.rfb.viewOnly = !canInteract(run);
    $('view-status').textContent = canInteract(run) ? 'Live display. Keyboard and mouse control are enabled.' : 'Live display, view only. Pause the run to use the keyboard and mouse.';
  } else if (!state.screenshotUrl) {
    $('browser-placeholder-text').textContent = active ? 'Loading a snapshot of the active browser…' : run.state === 'queued' ? 'Waiting for an available browser.' : run.state === 'starting' ? 'Starting the browser. Its view will appear here.' : 'This browser is no longer running. Its activity and any saved profile remain below.';
  }
  if (!active && state.screenshotUrl) $('view-status').textContent = 'Last captured snapshot. This browser is no longer active.';
}

function actionButton(label, action, style = 'outline') {
  const button = el('button', `button small ${style}`, label); button.type = 'button'; button.disabled = state.actionBusy;
  button.addEventListener('click', () => runAction(action)); return button;
}
function renderActions(run) {
  const actions = $('run-actions'); actions.replaceChildren();
  if (run.waitingForFinish && ACTIVE.has(run.state)) actions.append(actionButton('Finish & save', 'finish', 'primary'));
  if (run.state === 'paused' || run.pauseRequested) actions.append(actionButton(run.state === 'paused' ? 'Resume' : 'Undo pause', 'resume'));
  else if (run.state === 'running' && !run.waitingForFinish) actions.append(actionButton('Pause', 'pause'));
  if (run.profileId && (run.state === 'export_failed' || run.state === 'interrupted' || needsCleanupRecovery(run))) actions.append(actionButton('Retry export', 'retry-export', 'primary'));
  if (IN_PROGRESS.has(run.state) && run.state !== 'saving') actions.append(actionButton('Cancel run', 'cancel', 'quiet danger'));
  if (!IN_PROGRESS.has(run.state)) {
    const again = el('button', 'button outline small', 'New run with this script'); again.type = 'button'; again.addEventListener('click', () => openNewRun(run.automationId)); actions.append(again);
  }
  if (!actions.children.length) actions.append(el('span', 'small-note', run.state === 'saving' ? 'Exporting and verifying the profile…' : 'No actions available.'));
}
async function runAction(action) {
  const run = selectedRun(); if (!run || state.actionBusy) return;
  if (action === 'cancel' && !window.confirm('Cancel this run? The current automation will stop.')) return;
  state.actionBusy = true; renderActions(run);
  try {
    const result = await api(`/api/runs/${encodeURIComponent(run.id)}/${action}`, { method: 'POST' });
    upsertRun(result); renderList(); renderDetail();
    toast(({ pause: 'Pause requested. The script will pause at its next checkpoint.', resume: 'Run resumed.', cancel: 'Run cancelled.', finish: 'Finishing the run and saving its profile.', 'retry-export': 'Export retry requested.' })[action]);
  } catch (error) { toast(messageOf(error)); }
  finally { state.actionBusy = false; if (selectedRun()) renderActions(selectedRun()); }
}

function renderActivity(run) {
  const log = $('activity-log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 50;
  const entries = Array.isArray(run.logs) ? run.logs : [];
  $('activity-count').textContent = `${entries.length} event${entries.length === 1 ? '' : 's'}`;
  log.replaceChildren();
  if (!entries.length) log.append(el('li', 'log-empty', 'Activity will appear as the automation runs.'));
  entries.forEach(entry => {
    const row = el('li'); const time = el('time', '', timeOf(entry.time)); time.dateTime = entry.time || '';
    row.append(time, el('span', 'log-message', String(entry.message || ''))); log.append(row);
  });
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function normalizedSchema(schema) { return schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} }; }
function secretField(name, field) { return field.writeOnly === true || field.format === 'password' || field['x-secret'] === true || /password|passphrase|token|secret|otp|verification.?code/i.test(name); }
function schemaHasComplexRoot(schema) { return Boolean(schema.oneOf || schema.anyOf || schema.allOf || (schema.type && schema.type !== 'object')); }
function buildFields(container, rawSchema, prefix) {
  container.replaceChildren(); const schema = normalizedSchema(rawSchema); const required = new Set(schema.required || []);
  const properties = schema.properties || {};
  Object.entries(properties).forEach(([name, rawField], index) => {
    const field = rawField && typeof rawField === 'object' ? rawField : {};
    const type = Array.isArray(field.type) ? field.type.find(item => item !== 'null') : field.type || 'string';
    const wrapper = el('div', `schema-field${type === 'boolean' ? ' checkbox-field' : ''}`);
    const id = `${prefix}-field-${index}`; const label = el('label', '', field.title || name); label.htmlFor = id;
    if (!required.has(name)) label.append(el('span', 'optional', 'optional'));
    let control;
    if (Array.isArray(field.enum)) {
      control = el('select');
      const empty = el('option', '', 'Select a value'); empty.value = ''; control.append(empty);
      field.enum.forEach((value, optionIndex) => { const option = el('option', '', typeof value === 'string' ? value : JSON.stringify(value)); option.value = String(optionIndex); control.append(option); });
      control.dataset.enum = JSON.stringify(field.enum);
      if (field.default !== undefined && !secretField(name, field)) { const defaultIndex = field.enum.findIndex(item => JSON.stringify(item) === JSON.stringify(field.default)); if (defaultIndex >= 0) control.value = String(defaultIndex); }
    } else if (type === 'boolean') {
      control = el('input'); control.type = 'checkbox'; control.checked = field.default === true;
    } else if (type === 'object' || type === 'array' || field.oneOf || field.anyOf || field.allOf) {
      control = el('textarea', 'json-editor'); control.rows = 5; control.dataset.json = 'true'; control.spellcheck = false;
      control.value = field.default === undefined ? required.has(name) ? type === 'array' ? '[]' : '{}' : '' : JSON.stringify(field.default, null, 2);
      control.placeholder = type === 'array' ? '[]' : '{}';
    } else {
      control = el('input'); control.type = secretField(name, field) ? 'password' : type === 'number' || type === 'integer' ? 'number' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : 'text';
      if (type === 'number' || type === 'integer') { control.step = type === 'integer' ? '1' : 'any'; if (field.minimum !== undefined) control.min = String(field.minimum); if (field.maximum !== undefined) control.max = String(field.maximum); }
      if (field.minLength !== undefined) control.minLength = field.minLength;
      if (field.maxLength !== undefined) control.maxLength = field.maxLength;
      if (field.pattern) control.pattern = field.pattern;
      if (field.default !== undefined && !secretField(name, field)) control.value = String(field.default);
      if (field.examples?.length && !secretField(name, field)) control.placeholder = String(field.examples[0]);
    }
    control.id = id; control.dataset.field = name; control.dataset.type = type;
    if (type !== 'boolean') control.required = required.has(name);
    control.autocomplete = secretField(name, field) ? /otp|verification.?code/i.test(name) ? 'one-time-code' : 'off' : 'off';
    if (type === 'boolean') wrapper.append(control, label); else wrapper.append(label, control);
    if (field.description) { const hint = el('p', 'field-hint', field.description); hint.id = `${id}-hint`; control.setAttribute('aria-describedby', hint.id); wrapper.append(hint); }
    container.append(wrapper);
  });
}
function readFields(container) {
  const values = {};
  container.querySelectorAll('[data-field]').forEach(control => {
    const name = control.dataset.field;
    if (control.type === 'checkbox') { values[name] = control.checked; return; }
    if (control.value === '') return;
    if (control.dataset.enum) { if (control.value !== '') values[name] = JSON.parse(control.dataset.enum)[Number(control.value)]; return; }
    if (control.dataset.json) {
      try { values[name] = JSON.parse(control.value); } catch { throw new Error(`${name} must contain valid JSON.`); }
    } else if (control.dataset.type === 'number' || control.dataset.type === 'integer') {
      const value = Number(control.value); if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`); values[name] = value;
    } else values[name] = control.value;
  });
  return values;
}
function writeFields(container, values) {
  container.querySelectorAll('[data-field]').forEach(control => {
    const value = values[control.dataset.field];
    if (value === undefined) { if (control.type === 'checkbox') control.checked = false; else control.value = ''; return; }
    if (control.type === 'checkbox') control.checked = value === true;
    else if (control.dataset.enum) { const index = JSON.parse(control.dataset.enum).findIndex(item => JSON.stringify(item) === JSON.stringify(value)); control.value = index < 0 ? '' : String(index); }
    else control.value = control.dataset.json ? JSON.stringify(value, null, 2) : String(value);
  });
}

function renderChallenge(run) {
  const challenge = run.state === 'awaiting_input' ? run.challenge : null;
  $('challenge-panel').hidden = !challenge;
  if (!challenge) { state.challengeId = null; $('challenge-fields').replaceChildren(); return; }
  if (state.challengeId === challenge.id) return;
  state.challengeId = challenge.id;
  $('challenge-title').textContent = challenge.title || 'Input needed';
  $('challenge-description').textContent = challenge.description || 'The automation is waiting. Supply the requested input to continue.';
  buildFields($('challenge-fields'), challenge.fields || challenge.inputSchema, 'challenge');
  showError('challenge-error', '');
}

function populateAutomations() {
  const select = $('automation-select'); select.replaceChildren();
  if (!state.automations.length) { const option = el('option', '', 'No automations installed'); option.value = ''; select.append(option); }
  state.automations.forEach(item => { const option = el('option', '', item.title || item.id); option.value = item.id; select.append(option); });
  $('create-run-button').disabled = !state.automations.length;
  renderAutomationInputs();
}
function currentAutomation() { return state.automations.find(item => item.id === $('automation-select').value); }
function renderAutomationInputs() {
  const automation = currentAutomation(); const schema = normalizedSchema(automation?.inputSchema);
  $('automation-description').textContent = automation?.description || (automation ? '' : 'Add an automation to the server, then refresh the workbench.');
  buildFields($('input-fields'), schema, 'automation');
  state.jsonMode = schemaHasComplexRoot(schema) || (!Object.keys(schema.properties || {}).length && schema.additionalProperties === true);
  $('json-input').value = JSON.stringify(readFields($('input-fields')), null, 2);
  $('no-inputs').hidden = Object.keys(schema.properties || {}).length > 0 || state.jsonMode;
  updateInputMode(); showError('new-run-error', '');
}
function updateInputMode() {
  $('input-fields').hidden = state.jsonMode; $('json-input-wrap').hidden = !state.jsonMode;
  $('input-fields').querySelectorAll('input,select,textarea').forEach(control => { control.disabled = state.jsonMode; });
  $('input-mode-button').textContent = state.jsonMode ? 'Use form fields' : 'Edit as JSON';
}
function openNewRun(automationId) {
  if (!state.authenticated) return;
  $('new-run-form').reset(); state.jsonMode = false;
  if (automationId && state.automations.some(item => item.id === automationId)) $('automation-select').value = automationId;
  renderAutomationInputs(); $('new-run-dialog').showModal();
}

async function refreshSnapshot(manual = false) {
  const run = selectedRun(); if (!state.authenticated || !ACTIVE.has(run?.state) || state.rfb || state.livePending || state.screenshotBusy) return;
  const id = run.id; state.screenshotBusy = true; state.lastSnapshot = Date.now(); $('snapshot-button').disabled = true;
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}/screenshot`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) {
      if (response.status === 401) signOutLocally('Your session expired. Sign in again.');
      let message = 'Snapshot unavailable. The browser may still be starting.';
      try { const data = await response.json(); message = data.error || message; } catch { /* No JSON body. */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    if (!state.authenticated || state.selectedId !== id || state.rfb || state.livePending) return;
    if (!blob.type.startsWith('image/')) throw new Error('The browser did not return an image.');
    if (state.screenshotUrl) URL.revokeObjectURL(state.screenshotUrl);
    state.screenshotUrl = URL.createObjectURL(blob); state.snapshotRun = id;
    $('browser-snapshot').src = state.screenshotUrl; $('browser-snapshot').hidden = false; $('browser-placeholder').hidden = true;
    $('snapshot-time').textContent = `Captured ${timeOf(Date.now())}`;
    $('view-status').textContent = 'Snapshot, refreshed every 5 seconds. Connect live to interact.';
  } catch (error) {
    if (state.selectedId === id && !state.rfb && !state.livePending) {
      $('view-status').textContent = messageOf(error);
      $('browser-placeholder-text').textContent = messageOf(error);
      if (manual) toast(messageOf(error));
    }
  } finally { state.screenshotBusy = false; $('snapshot-button').disabled = !ACTIVE.has(selectedRun()?.state); }
}

async function connectLive() {
  if (state.rfb) { disconnectLive(); refreshSnapshot(); return; }
  const run = selectedRun(); if (!run || !ACTIVE.has(run.state) || state.livePending) return;
  state.livePending = true; const revision = ++state.liveRevision; const id = run.id;
  $('live-button').disabled = true; $('live-button').textContent = 'Connecting…'; $('view-status').textContent = 'Connecting to the browser display…';
  try {
    const view = await api(`/api/runs/${encodeURIComponent(id)}/view`);
    if (revision !== state.liveRevision || state.selectedId !== id || !state.authenticated) return;
    if (!view.available) throw new Error(view.reason || 'Live view is not configured for this browser.');
    if (view.transport !== 'vnc' || typeof view.websocketPath !== 'string') throw new Error('This live-view transport is not supported by the workbench.');
    const socketUrl = new URL(view.websocketPath, window.location.origin);
    if (socketUrl.origin !== window.location.origin) throw new Error('The live-view address must use the workbench gateway.');
    socketUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const { default: RFB } = await import('/vendor/novnc/core/rfb.js');
    if (revision !== state.liveRevision || state.selectedId !== id || !state.authenticated) return;
    $('live-screen').hidden = false; $('browser-snapshot').hidden = true; $('browser-placeholder').hidden = true;
    const rfb = new RFB($('live-screen'), socketUrl.href, { credentials: view.credentials || {} });
    state.rfb = rfb; rfb.scaleViewport = true; rfb.resizeSession = false; rfb.viewOnly = !canInteract(selectedRun()); rfb.focusOnClick = true;
    state.liveTimeout = setTimeout(() => {
      if (state.rfb !== rfb || !state.livePending) return;
      disconnectLive(); $('view-status').textContent = 'The display connection timed out. Check the server’s VNC configuration, or use snapshots.';
    }, 15000);
    rfb.addEventListener('connect', () => {
      if (state.rfb !== rfb) return;
      clearTimeout(state.liveTimeout);
      state.livePending = false; $('live-button').disabled = false; $('live-button').textContent = 'Disconnect live'; $('view-label').textContent = 'Live browser'; $('view-indicator').classList.add('live'); $('snapshot-button').hidden = true; $('snapshot-time').textContent = ''; renderDetail();
    });
    rfb.addEventListener('disconnect', event => {
      if (state.rfb !== rfb) return;
      disconnectLive(); $('view-status').textContent = event.detail.clean ? 'Live display disconnected. Snapshot view is available.' : 'Live connection ended. Reconnect or use snapshots.'; refreshSnapshot();
    });
    rfb.addEventListener('securityfailure', () => {
      if (state.rfb !== rfb) return;
      disconnectLive(); $('view-status').textContent = 'Display authentication failed. Check the server’s VNC configuration.';
    });
    rfb.addEventListener('credentialsrequired', () => {
      if (state.rfb !== rfb) return;
      disconnectLive(); $('view-status').textContent = 'Display credentials are missing. Configure the VNC password on the server.';
    });
  } catch (error) {
    if (revision !== state.liveRevision) return;
    disconnectLive(); $('view-status').textContent = messageOf(error); toast(messageOf(error));
  }
}

function proxyResult(proxy) { return proxy.health || proxy.lastCheck || proxy.check || null; }
function renderProxies() {
  const list = $('proxy-list'); list.replaceChildren(); $('proxy-count').textContent = String(state.proxies.length);
  if (!state.proxies.length) { list.append(el('p', 'list-empty', 'No proxy connections are configured. Add inventory on the server to make it available to scripts.')); return; }
  state.proxies.forEach(proxy => {
    const row = el('div', 'proxy-row'); const heading = el('div', 'proxy-row-heading');
    heading.append(el('strong', '', proxy.label || proxy.name || proxy.id || 'Proxy'));
    const check = el('button', 'button outline small', 'Check'); check.type = 'button'; check.disabled = !proxy.id || proxy.enabled === false || proxy.leased === true;
    check.addEventListener('click', async () => {
      check.disabled = true; check.textContent = 'Checking…';
      try {
        const result = await api(`/api/proxies/${encodeURIComponent(proxy.id)}/check`, { method: 'POST' });
        const previous = row.querySelector('.proxy-result'); previous?.remove();
        const verification = result?.verified || result;
        const healthy = result?.ok ?? result?.healthy ?? (Boolean(result?.verified?.exitIp) || result?.status === 'healthy');
        const summary = typeof result?.error === 'string' ? result.error : healthy ? `Connection healthy${verification.exitIp || verification.ip ? `; exit ${verification.exitIp || verification.ip}` : ''}${Number.isFinite(verification.latencyMs) ? `; ${verification.latencyMs} ms` : ''}` : 'Check completed. Refresh the inventory for current status.';
        row.append(el('p', `proxy-result${healthy ? '' : ' warning'}`, summary));
      } catch (error) { const previous = row.querySelector('.proxy-result'); previous?.remove(); row.append(el('p', 'proxy-result warning', messageOf(error))); }
      finally { check.disabled = false; check.textContent = 'Check'; }
    });
    heading.append(check); row.append(heading);
    const metadata = [proxy.protocol || proxy.type, proxy.attributes?.country || proxy.country, proxy.attributes?.city, proxy.attributes?.type, proxy.source || proxy.provider, proxy.enabled === false ? 'Disabled' : proxy.leased || proxy.leasedTo ? 'In use' : proxy.status || 'Available'].filter(value => typeof value === 'string' && value);
    if (metadata.length) row.append(el('p', '', metadata.join(' / ')));
    const health = proxyResult(proxy);
    if (health) {
      const healthy = health.ok ?? health.healthy ?? health.status === 'healthy';
      row.append(el('p', `proxy-result${healthy ? '' : ' warning'}`, typeof health === 'string' ? health : health.error || (healthy ? `Healthy${health.exitIp || health.ip ? `; exit ${health.exitIp || health.ip}` : ''}` : 'Not yet verified')));
    }
    if (proxy.expiresAt) row.append(el('p', '', `Expires ${fullDate(proxy.expiresAt)}`));
    list.append(row);
  });
}
async function loadSystem() {
  $('refresh-system-button').disabled = true;
  try {
    const [status, proxies] = await Promise.all([api('/api/status'), api('/api/proxies')]);
    if (!state.authenticated) return;
    state.status = status; state.proxies = Array.isArray(proxies) ? proxies : proxies.items || [];
    renderStatus(); renderProxies();
  } catch (error) { $('proxy-list').replaceChildren(el('p', 'form-error', messageOf(error))); }
  finally { $('refresh-system-button').disabled = false; }
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); showError('login-error', ''); $('login-button').disabled = true; $('login-status').textContent = 'Signing in…';
  try { await api('/api/login', { method: 'POST', body: { token: $('access-token').value } }); await loadWorkspace(); }
  catch (error) { showError('login-error', messageOf(error)); $('login-status').textContent = ''; }
  finally { $('login-button').disabled = false; }
});
$('logout-button').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); signOutLocally('Signed out.'); }
  catch (error) { toast(`Could not sign out: ${messageOf(error)}`); }
});
$('new-run-button').addEventListener('click', () => openNewRun());
$('empty-new-button').addEventListener('click', () => openNewRun());
$('refresh-button').addEventListener('click', () => refreshAll());
$('run-search').addEventListener('input', event => { state.query = event.target.value; renderList(); });
$('run-filter').addEventListener('change', event => { state.filter = event.target.value; renderList(); });
document.querySelectorAll('[data-collection]').forEach(tab => {
  tab.addEventListener('click', () => {
    state.collection = tab.dataset.collection;
    document.querySelectorAll('[data-collection]').forEach(item => { const selected = item === tab; item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1; });
    $('run-list-panel').setAttribute('aria-labelledby', tab.id); renderList();
  });
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const target = event.key === 'Home' ? $('runs-tab') : event.key === 'End' ? $('archives-tab') : tab.id === 'runs-tab' ? $('archives-tab') : $('runs-tab'); target.click(); target.focus();
  });
});
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('new-run-dialog').addEventListener('close', () => { $('new-run-form').reset(); $('input-fields').replaceChildren(); $('json-input').value = '{}'; });
$('automation-select').addEventListener('change', renderAutomationInputs);
$('input-mode-button').addEventListener('click', () => {
  try {
    if (state.jsonMode) {
      const values = JSON.parse($('json-input').value);
      if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('Inputs must be a JSON object.');
      const known = new Set(Object.keys(currentAutomation()?.inputSchema?.properties || {}));
      if (schemaHasComplexRoot(currentAutomation()?.inputSchema || {}) || Object.keys(values).some(key => !known.has(key))) throw new Error('These inputs need the JSON editor. Form fields cannot represent every property.');
      writeFields($('input-fields'), values);
    } else $('json-input').value = JSON.stringify(readFields($('input-fields')), null, 2);
    state.jsonMode = !state.jsonMode; updateInputMode(); showError('new-run-error', '');
  } catch (error) { showError('new-run-error', messageOf(error)); }
});
$('new-run-form').addEventListener('submit', async event => {
  event.preventDefault(); showError('new-run-error', '');
  const submit = $('create-run-button'); submit.disabled = true; submit.textContent = 'Starting…';
  try {
    const inputs = state.jsonMode ? JSON.parse($('json-input').value) : readFields($('input-fields'));
    if (!inputs || Array.isArray(inputs) || typeof inputs !== 'object') throw new Error('Inputs must be a JSON object.');
    const run = await api('/api/runs', { method: 'POST', body: { automationId: $('automation-select').value, inputs, preset: $('new-run-form').elements.preset.value } });
    if (!state.authenticated) return;
    upsertRun(run); $('new-run-dialog').close(); $('runs-tab').click(); state.filter = 'all'; $('run-filter').value = 'all'; state.query = ''; $('run-search').value = ''; selectRun(run.id); toast('Run created.');
  } catch (error) { showError('new-run-error', messageOf(error)); }
  finally { submit.disabled = !state.automations.length; submit.textContent = 'Start run'; }
});
$('challenge-form').addEventListener('submit', async event => {
  event.preventDefault(); const run = selectedRun(); if (!run?.challenge) return;
  const submit = event.target.querySelector('button[type="submit"]'); submit.disabled = true; showError('challenge-error', '');
  try {
    const values = readFields($('challenge-fields'));
    const result = await api(`/api/runs/${encodeURIComponent(run.id)}/input`, { method: 'POST', body: { challengeId: run.challenge.id, values } });
    $('challenge-form').reset(); upsertRun(result); renderDetail(); renderList(); toast('Input sent.');
  } catch (error) { showError('challenge-error', messageOf(error)); }
  finally { submit.disabled = false; }
});
$('snapshot-button').addEventListener('click', () => refreshSnapshot(true));
$('live-button').addEventListener('click', connectLive);
$('fullscreen-button').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('browser-stage').requestFullscreen(); }
  catch { toast('Fullscreen is not available in this browser.'); }
});
$('system-button').addEventListener('click', () => { $('system-dialog').showModal(); renderStatus(); $('proxy-list').replaceChildren(el('p', 'list-empty', 'Loading connections…')); loadSystem(); });
$('refresh-system-button').addEventListener('click', loadSystem);
window.addEventListener('pagehide', () => { state.source?.close(); disconnectLive({ reset: false }); clearInterval(state.interval); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.authenticated) refreshAll(false); });

try { const session = await api('/api/session'); if (session?.authenticated) await loadWorkspace(); else signOutLocally(); }
catch { $('login-status').textContent = 'Sign in to access your browsers.'; }
