(function () {
    'use strict';

    /**
     * Database Compare page logic (saved connections).
     * Add or replace a connection, test it, remove it. A connection string is
     * sent to the main process only when saved; the page only gets names and
     * hosts back. Every database check runs read-only in the main process.
     */

    let connections = [];
    let busy = false;
    // Result of the last test per connection, for as long as this page stays open.
    const lastTests = {};

window.pageInit = async function () {
    const saveBtn = document.getElementById('btn-db-conn-save');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveConnection);
    }

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
    const saveBtn = document.getElementById('btn-db-conn-save');
    if (saveBtn) saveBtn.disabled = busy;
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
    busy = true;
    lastTests[name] = { state: 'running' };
    renderConnections();
    setStatus(`Testing ${name}...`, 'busy');

    try {
        lastTests[name] = await window.api.testDbConnection(name);
    } catch (err) {
        lastTests[name] = { ok: false, message: err.message };
    }

    busy = false;
    renderConnections();
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
})();