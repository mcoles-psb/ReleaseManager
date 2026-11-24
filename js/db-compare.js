(function () {
    'use strict';

    /**
     * Database Compare page logic.
     * - Compare: reads two saved databases' structure (read-only, in the main
     *   process) and lists what is only on one side or different, with
     *   filters and a CSV export of the rows shown.
     * - Connections: add or replace, test, remove. A connection string is sent
     *   to the main process only when saved; the page only gets names and
     *   hosts back.
     */

    const CATEGORY_LABELS = {
        types: 'Type',
        tables: 'Table / view',
        columns: 'Column',
        keys: 'Key / constraint',
        indexes: 'Index',
        triggers: 'Trigger',
        functions: 'Function',
        sequences: 'Sequence',
        policies: 'Policy'
    };

    let connections = [];
    let busy = false;
    let lastResult = null;
    // Row ids whose detail is open; cleared on every new compare.
    const expanded = new Set();
    // Row ids ticked for the script; kept across filters, cleared on every new compare.
    const picked = new Set();
    // Result of the last test per connection, for as long as this page stays open.
    const lastTests = {};

window.pageInit = async function () {
    bindClick('btn-db-conn-save', saveConnection);
    bindClick('btn-db-compare', runCompare);
    bindClick('btn-db-export', exportCompare);
    bindClick('btn-db-script', buildScript);
    bindClick('btn-db-script-copy', copyScript);
    bindClick('btn-db-script-save', saveScript);

    // One listener for every differences row (inline handlers are blocked by the CSP).
    const compareBody = document.getElementById('db-compare-body');
    if (compareBody) {
        compareBody.addEventListener('click', (event) => {
            // The tick box cell only ticks; it does not open or close the row.
            if (event.target.closest('.db-pick-cell')) return;
            // Selecting text in a row should not open or close it.
            if (window.getSelection && String(window.getSelection())) return;
            toggleRow(event.target.closest('tr.db-diff-row'));
        });
        compareBody.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (event.target.closest('.db-pick-cell')) return;
            const row = event.target.closest('tr.db-diff-row');
            if (!row) return;
            event.preventDefault();
            toggleRow(row);
        });
        compareBody.addEventListener('change', (event) => {
            const box = event.target.closest('input.db-pick');
            if (!box) return;
            if (box.checked) {
                picked.add(box.dataset.id);
            } else {
                picked.delete(box.dataset.id);
            }
            updatePicks();
        });
    }

    // Header box: ticks or unticks every row currently shown.
    const pickAll = document.getElementById('db-pick-all');
    if (pickAll) {
        pickAll.addEventListener('change', () => {
            filteredRows().forEach((row) => {
                if (pickAll.checked) {
                    picked.add(row.id);
                } else {
                    picked.delete(row.id);
                }
            });
            renderCompare();
        });
    }
    ['db-filter-category', 'db-filter-app', 'db-filter-status'].forEach((id) => {
        const select = document.getElementById(id);
        if (select) select.addEventListener('change', renderCompare);
    });

    // One listener for every row's buttons. Inline onclick attributes are
    // blocked by the app's Content-Security-Policy.
    const tbody = document.getElementById('db-conn-table-body');
    if (tbody) {
        tbody.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-action]');
            if (!button || button.disabled) return;
            if (button.dataset.action === 'test') {
                testConnection(button.dataset.name);
            } else if (button.dataset.action === 'remove') {
                removeConnection(button.dataset.name);
            }
        });
    }

    await loadConnections();
};

function bindClick(id, handler) {
    const element = document.getElementById(id);
    if (element) element.addEventListener('click', handler);
}

function valueOf(id) {
    const element = document.getElementById(id);
    return element ? element.value : '';
}

/**
 * Enables or disables the page's buttons while something is running.
 */
function setBusy(value) {
    busy = value;
    ['btn-db-compare', 'btn-db-conn-save'].forEach((id) => {
        const button = document.getElementById(id);
        if (button) button.disabled = busy;
    });
    const exportBtn = document.getElementById('btn-db-export');
    if (exportBtn) exportBtn.disabled = busy || !lastResult;
    const scriptBtn = document.getElementById('btn-db-script');
    if (scriptBtn) scriptBtn.disabled = busy || !lastResult || picked.size === 0;
    renderConnections();
}

// ─── Connections ─────────────────────────────────────────────────────────────

/**
 * Reads the saved connections (names and hosts) from the main process.
 */
async function loadConnections() {
    try {
        connections = await window.api.getDbConnections();
    } catch (err) {
        connections = [];
        showToast(`Could not read the saved connections: ${err.message}`, 'error');
    }
    renderConnections();
    fillConnectionSelects();
}

/**
 * Fills the Compare / With pickers, keeping the current choice when it still
 * exists. By default the first two connections are picked.
 */
function fillConnectionSelects() {
    const names = connections.map(c => c.name);
    ['db-left', 'db-right'].forEach((id, index) => {
        const select = document.getElementById(id);
        if (!select) return;
        const previous = select.value;
        select.innerHTML = names.length
            ? names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')
            : '<option value="">No saved connections</option>';
        select.value = names.includes(previous) ? previous : (names[index] || names[0] || '');
    });
}

function testCell(name) {
    const test = lastTests[name];
    if (!test) return '<span class="text-muted">-</span>';
    if (test.state === 'running') return '<span class="badge badge-info">Testing...</span>';
    if (test.ok) {
        const details = `${test.database} · Postgres ${test.version}${test.readOnly ? ' · read-only' : ''}`;
        return `<span class="badge badge-success">Connected</span><div class="text-muted" style="font-size:11px;">${escapeHtml(details)}</div>`;
    }
    return `<span class="badge badge-error">Failed</span><div class="text-muted" style="font-size:11px;">${escapeHtml(test.message || '')}</div>`;
}

/**
 * Draws the connections table.
 */
function renderConnections() {
    const tbody = document.getElementById('db-conn-table-body');
    if (!tbody) return;

    if (connections.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" style="text-align:center;padding:24px;">
                    <span class="text-muted">No connections yet. Add QAS and PROD below.</span>
                </td>
            </tr>
        `;
        return;
    }

    const disabled = busy ? 'disabled' : '';
    tbody.innerHTML = connections.map(connection => {
        const safeName = escapeHtml(connection.name);
        return `
            <tr>
                <td><strong>${safeName}</strong></td>
                <td><span class="text-muted" style="font-size:11px;">${escapeHtml(connection.host)}</span></td>
                <td>${testCell(connection.name)}</td>
                <td>
                    <button class="btn btn-sm btn-text" data-action="test" data-name="${safeName}" ${disabled}>Test</button>
                    <button class="btn btn-sm btn-text btn-danger" data-action="remove" data-name="${safeName}" ${disabled}>Remove</button>
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * Saves (or replaces) a connection, then tests it.
 */
async function saveConnection() {
    if (busy) return;
    const nameInput = document.getElementById('db-conn-name');
    const stringInput = document.getElementById('db-conn-string');
    const name = nameInput.value.trim();

    try {
        const result = await window.api.saveDbConnection(name, stringInput.value.trim());
        if (!result.success) {
            showToast(result.message || 'Could not save the connection.', 'error');
            return;
        }
    } catch (err) {
        showToast(`Could not save the connection: ${err.message}`, 'error');
        return;
    }

    nameInput.value = '';
    stringInput.value = '';
    delete lastTests[name];
    showToast(`${name} saved. Testing it now...`, 'success');
    await loadConnections();
    await testConnection(name);
}

/**
 * Connects read-only and shows the result in the Last Test column.
 * @param {string} name - Connection name
 */
async function testConnection(name) {
    if (busy || !name) return;
    lastTests[name] = { state: 'running' };
    setBusy(true);
    setStatus(`Testing ${name}...`, 'busy');

    try {
        lastTests[name] = await window.api.testDbConnection(name);
    } catch (err) {
        lastTests[name] = { ok: false, message: err.message };
    }

    setBusy(false);
    refreshLogConsole();
    if (lastTests[name].ok) {
        setStatus(`${name} connected`, 'success');
    } else {
        showToast(`${name} could not connect: ${lastTests[name].message || 'unknown error'}`, 'error');
        setStatus(`${name} could not connect`, 'error');
    }
}

/**
 * Takes a connection off the list. Nothing in the database is touched.
 * @param {string} name - Connection name
 */
async function removeConnection(name) {
    if (busy || !name) return;
    const confirmed = await window.api.confirm(
        'Remove Connection',
        `Remove the ${name} connection?`,
        'Only the saved connection is removed from this computer. Nothing in the database is touched.'
    );
    if (!confirmed) return;

    try {
        await window.api.removeDbConnection(name);
        delete lastTests[name];
        showToast(`${name} removed.`, 'info');
        await loadConnections();
    } catch (err) {
        showToast(`Could not remove the connection: ${err.message}`, 'error');
    }
}

// ─── Compare ─────────────────────────────────────────────────────────────────

/**
 * Runs the compare for the picked connections and schema.
 */
async function runCompare() {
    if (busy) return;
    const left = valueOf('db-left');
    const right = valueOf('db-right');
    const schema = valueOf('db-schema').trim() || 'public';
    if (!left || !right) {
        showToast('Add and pick two connections first.', 'error');
        return;
    }
    if (left === right) {
        showToast('Pick two different connections.', 'error');
        return;
    }

    setBusy(true);
    setStatus(`Comparing ${left} with ${right}...`, 'busy');
    const summary = document.getElementById('db-compare-summary');
    if (summary) summary.textContent = `Reading ${left} and ${right}...`;

    try {
        const response = await window.api.runDbCompare(left, right, schema);
        if (!response.success) {
            throw new Error(response.message || 'Compare failed.');
        }
        lastResult = response.result;
        hideScript();
        expanded.clear();
        picked.clear();
        fillFilterLabels();
        renderCompare();
        setStatus('Compare complete', 'success');
        showToast(`${lastResult.rows.length} difference${lastResult.rows.length === 1 ? '' : 's'} found.`, lastResult.rows.length ? 'info' : 'success');
    } catch (err) {
        if (summary) summary.textContent = `Compare failed: ${err.message}`;
        showToast(`Compare failed: ${err.message}`, 'error');
        setStatus('Compare failed', 'error');
    } finally {
        setBusy(false);
        refreshLogConsole();
    }
}

/**
 * After a compare: names the Only-in options and column headers after the
 * two connections, and lists the apps found in the differences.
 */
function fillFilterLabels() {
    if (!lastResult) return;
    const statusSelect = document.getElementById('db-filter-status');
    if (statusSelect) {
        const leftOption = statusSelect.querySelector('option[value="only-left"]');
        const rightOption = statusSelect.querySelector('option[value="only-right"]');
        if (leftOption) leftOption.textContent = `Only in ${lastResult.left}`;
        if (rightOption) rightOption.textContent = `Only in ${lastResult.right}`;
    }
    const leftHeader = document.getElementById('db-col-left');
    const rightHeader = document.getElementById('db-col-right');
    if (leftHeader) leftHeader.textContent = lastResult.left;
    if (rightHeader) rightHeader.textContent = lastResult.right;

    const directionSelect = document.getElementById('db-script-direction');
    if (directionSelect) {
        const toRight = directionSelect.querySelector('option[value="left-to-right"]');
        const toLeft = directionSelect.querySelector('option[value="right-to-left"]');
        if (toRight) toRight.textContent = `Add to ${lastResult.right} what ${lastResult.left} has`;
        if (toLeft) toLeft.textContent = `Add to ${lastResult.left} what ${lastResult.right} has`;
    }

    const appSelect = document.getElementById('db-filter-app');
    if (appSelect) {
        const previous = appSelect.value;
        const apps = [...new Set(lastResult.rows.map(row => row.app))].sort();
        appSelect.innerHTML = '<option value="">All apps</option>'
            + apps.map(app => `<option value="${escapeHtml(app)}">${escapeHtml(app)}</option>`).join('');
        appSelect.value = apps.includes(previous) ? previous : '';
    }
}

/**
 * The compare rows that match the Type / App / Difference filters.
 */
function filteredRows() {
    if (!lastResult) return [];
    const category = valueOf('db-filter-category');
    const app = valueOf('db-filter-app');
    const status = valueOf('db-filter-status');
    return lastResult.rows.filter(row =>
        (!category || row.category === category)
        && (!app || row.app === app)
        && (!status || row.status === status));
}

function statusBadge(status) {
    if (status === 'only-left') return `<span class="badge badge-warning">Only in ${escapeHtml(lastResult.left)}</span>`;
    if (status === 'only-right') return `<span class="badge badge-info">Only in ${escapeHtml(lastResult.right)}</span>`;
    return '<span class="badge badge-error">Different</span>';
}

function summaryText(shownCount) {
    const totals = lastResult.totals || {};
    const counts = Object.keys(CATEGORY_LABELS)
        .filter(category => totals[category])
        .map(category => `${category} ${totals[category].left}/${totals[category].right}`)
        .join(', ');
    const total = lastResult.rows.length;
    const shown = shownCount === total ? '' : ` (showing ${shownCount})`;
    return `${lastResult.left} vs ${lastResult.right}, schema ${lastResult.schema}: ${total} difference${total === 1 ? '' : 's'}${shown}, ${picked.size} ticked for the script. Counts ${lastResult.left}/${lastResult.right}: ${counts}.`;
}

/**
 * Draws the summary line and the differences table.
 */
function renderCompare() {
    const tbody = document.getElementById('db-compare-body');
    const summary = document.getElementById('db-compare-summary');
    if (!lastResult || !tbody) return;

    const rows = filteredRows();
    updatePicks(rows);

    if (lastResult.rows.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8" style="text-align:center;padding:24px;">
                    <span class="badge badge-success">Same</span>
                    <span class="text-muted">No differences found in schema ${escapeHtml(lastResult.schema)}.</span>
                </td>
            </tr>
        `;
        return;
    }
    if (rows.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8" style="text-align:center;padding:24px;">
                    <span class="text-muted">No differences match the filters.</span>
                </td>
            </tr>
        `;
        return;
    }

    const dash = '<span class="text-muted">-</span>';
    tbody.innerHTML = rows.map(row => {
        const open = expanded.has(row.id);
        const line = `
            <tr class="db-diff-row${open ? ' is-open' : ''}" data-id="${escapeHtml(row.id)}" tabindex="0" aria-expanded="${open}">
                <td class="db-pick-cell"><input type="checkbox" class="db-pick" data-id="${escapeHtml(row.id)}" aria-label="Include ${escapeHtml(row.name)} in the script" ${picked.has(row.id) ? 'checked' : ''}></td>
                <td>${statusBadge(row.status)}</td>
                <td>${escapeHtml(CATEGORY_LABELS[row.category] || row.category)}</td>
                <td><span class="text-muted">${escapeHtml(row.app)}</span></td>
                <td title="${escapeHtml(row.table)}">${escapeHtml(row.table) || dash}</td>
                <td title="${escapeHtml(row.name)}"><strong>${escapeHtml(row.name)}</strong></td>
                <td class="db-diff-def">${escapeHtml(row.left) || dash}</td>
                <td class="db-diff-def">${escapeHtml(row.right) || dash}</td>
            </tr>
        `;
        if (!open) return line;

        const leftText = row.leftDetail || row.left;
        const rightText = row.rightDetail || row.right;
        return `${line}
            <tr class="db-diff-detail">
                <td colspan="8">
                    <div class="db-diff-sides">
                        <div>
                            <div class="db-diff-side-title">${escapeHtml(lastResult.left)}</div>
                            <div class="db-diff-code">${sideHtml(leftText, rightText, 'left')}</div>
                        </div>
                        <div>
                            <div class="db-diff-side-title">${escapeHtml(lastResult.right)}</div>
                            <div class="db-diff-code">${sideHtml(rightText, leftText, 'right')}</div>
                        </div>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * One side of a row detail: the full text, one line per line, with the lines
 * that the other side does not have marked.
 */
function sideHtml(text, otherText, side) {
    if (!text) return '<span class="text-muted">Not in this database.</span>';
    const otherLines = new Set(String(otherText || '').split('\n').map(item => item.trim()));
    return String(text).split('\n').map(item => {
        const marked = otherText && !otherLines.has(item.trim());
        return `<div class="db-line${marked ? ` db-line-${side}` : ''}">${escapeHtml(item) || '&nbsp;'}</div>`;
    }).join('');
}

/**
 * Opens or closes one row's detail.
 */
function toggleRow(row) {
    if (!row || !row.dataset.id) return;
    const id = row.dataset.id;
    if (expanded.has(id)) {
        expanded.delete(id);
    } else {
        expanded.add(id);
    }
    renderCompare();
}

/**
 * Updates what shows the ticks: the summary line, the header box (ticked,
 * partly ticked or not) and the Get Script button with its count.
 * @param {object[]} rows - the rows currently shown
 */
function updatePicks(rows = filteredRows()) {
    if (!lastResult) return;
    const summary = document.getElementById('db-compare-summary');
    if (summary) summary.textContent = summaryText(rows.length);

    const pickAll = document.getElementById('db-pick-all');
    if (pickAll) {
        const shownPicked = rows.filter(row => picked.has(row.id)).length;
        pickAll.disabled = rows.length === 0;
        pickAll.checked = rows.length > 0 && shownPicked === rows.length;
        pickAll.indeterminate = shownPicked > 0 && shownPicked < rows.length;
    }

    const scriptBtn = document.getElementById('btn-db-script');
    if (scriptBtn) {
        scriptBtn.textContent = picked.size ? `Get Script (${picked.size})` : 'Get Script';
        scriptBtn.disabled = busy || picked.size === 0;
    }
}

/**
 * Saves the rows currently shown to a CSV file in the Reports folder and
 * opens that folder.
 */
async function exportCompare() {
    if (busy || !lastResult) return;
    try {
        const response = await window.api.exportDbCompare({
            left: lastResult.left,
            right: lastResult.right,
            schema: lastResult.schema,
            rows: filteredRows()
        });
        if (!response.success) {
            showToast(response.message || 'Could not export.', 'error');
            return;
        }
        showToast(`Saved ${response.fileName} in the Reports folder.`, 'success');
        refreshLogConsole();
        window.api.openPath(response.folder);
    } catch (err) {
        showToast(`Could not export: ${err.message}`, 'error');
    }
}

// ─── Script ──────────────────────────────────────────────────────────────────

/**
 * Asks the main process for a script, for the rows currently shown, that
 * adds to one side what the other side has. Text only: never run.
 */
async function buildScript() {
    if (busy || !lastResult) return;
    if (picked.size === 0) {
        showToast('Tick the rows the script should include first.', 'error');
        return;
    }
    const direction = valueOf('db-script-direction') || 'left-to-right';
    const includeBox = document.getElementById('db-script-functions');
    const includeFunctions = Boolean(includeBox && includeBox.checked);

    try {
        const response = await window.api.buildDbScript(direction, [...picked], includeFunctions);
        if (!response.success) {
            showToast(response.message || 'Could not build the script.', 'error');
            return;
        }
        showScript(response);
        refreshLogConsole();
    } catch (err) {
        showToast(`Could not build the script: ${err.message}`, 'error');
    }
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Shows the built script and its summary.
 */
function showScript(response) {
    const panel = document.getElementById('db-script-panel');
    const title = document.getElementById('db-script-title');
    const summary = document.getElementById('db-script-summary');
    const text = document.getElementById('db-script-text');
    if (!panel || !text) return;

    if (title) title.textContent = `Script: add to ${response.targetName} what ${response.sourceName} has`;
    if (summary) {
        const parts = [
            `${plural(response.liveCount, 'step')} to run`,
            plural(response.reviewCount, 'review note'),
            `${plural(response.onlyTargetCount, 'item')} only in ${response.targetName} (not removed)`
        ];
        if (response.skipped) parts.push(`${plural(response.skipped, 'function/trigger item')} skipped`);
        summary.textContent = `${parts.join(', ')}. Release Manager does not run it. Run it on ${response.targetName} yourself: as it is, it is a PREVIEW (every step runs and is reported, then everything is rolled back); set rm__apply to true at its top to APPLY.`;
    }
    text.value = response.script;
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideScript() {
    const panel = document.getElementById('db-script-panel');
    if (panel) panel.classList.add('hidden');
    const text = document.getElementById('db-script-text');
    if (text) text.value = '';
}

async function copyScript() {
    const text = document.getElementById('db-script-text');
    if (!text || !text.value) return;
    try {
        await window.api.writeToClipboard(text.value);
        showToast('Script copied.', 'success');
    } catch (err) {
        showToast(`Could not copy: ${err.message}`, 'error');
    }
}

/**
 * Saves the last built script as a .sql file in the Reports folder and opens
 * that folder.
 */
async function saveScript() {
    try {
        const response = await window.api.saveDbScript();
        if (!response.success) {
            showToast(response.message || 'Could not save the script.', 'error');
            return;
        }
        showToast(`Saved ${response.fileName} in the Reports folder.`, 'success');
        refreshLogConsole();
        window.api.openPath(response.folder);
    } catch (err) {
        showToast(`Could not save the script: ${err.message}`, 'error');
    }
}
})();