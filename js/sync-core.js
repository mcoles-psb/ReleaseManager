(function () {
    'use strict';

    /**
     * Sync Core page logic.
    * Manages the page's own list of projects (add / remove), shows whether
    * each working folder already contains core's latest commit, and runs the
    * core sync for one project or for all projects that are behind.
     */

    let statusData = null;
    let syncing = false;
    // Result of the last sync per project, for as long as this page stays open.
    const lastResults = {};

window.pageInit = async function () {
    const addBtn = document.getElementById('btn-core-sync-add');
    if (addBtn) {
        addBtn.addEventListener('click', addProject);
    }
    const refreshBtn = document.getElementById('btn-core-sync-refresh');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadStatus);
    }
    const syncAllBtn = document.getElementById('btn-core-sync-all');
    if (syncAllBtn) {
        syncAllBtn.addEventListener('click', syncAll);
    }

    // One listener for every row's buttons. Inline onclick attributes are
    // blocked by the app's Content-Security-Policy.
    const tbody = document.getElementById('core-sync-table-body');
    if (tbody) {
        tbody.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-action]');
            if (!button || button.disabled) return;
            if (button.dataset.action === 'sync') {
                syncProjects([button.dataset.repo]);
            } else if (button.dataset.action === 'remove') {
                removeProject(button.dataset.repo);
            }
        });
    }

    await loadStatus();
};

/**
 * Reads the state of every listed project's working folder from the main process.
 */
async function loadStatus() {
    if (syncing) return;
    setStatus('Checking projects against core...', 'busy');
    try {
        statusData = await window.api.getCoreSyncStatus();
        render();
        setStatus('Sync Core ready', 'success');
    } catch (err) {
        document.getElementById('core-sync-table-body').innerHTML =
            `<tr><td colspan="7" class="text-error" style="text-align:center;padding:24px;">Error: ${escapeHtml(err.message)}</td></tr>`;
        setStatus('Failed to check projects', 'error');
    }
}

/**
 * Opens a folder picker (in the main process) and adds the chosen working
 * folder to the list.
 */
async function addProject() {
    if (syncing) return;
    try {
        const result = await window.api.addCoreSyncProject();
        if (result.canceled) return;
        if (!result.added) {
            showToast(result.message || 'Could not add the project.', 'error');
            return;
        }
        showToast(`${result.project.name} added.`, 'success');
        await loadStatus();
    } catch (err) {
        showToast(`Could not add the project: ${err.message}`, 'error');
    }
}

/**
 * Takes a project off the list. Its folder and files are not touched.
 * @param {string} name - Project name
 */
async function removeProject(name) {
    if (syncing || !name) return;
    const confirmed = await window.api.confirm(
        'Remove Project',
        `Remove ${name} from the Sync Core list?`,
        'Only the list entry is removed. The working folder and its files are not touched.'
    );
    if (!confirmed) return;

    try {
        await window.api.removeCoreSyncProject(name);
        delete lastResults[name];
        showToast(`${name} removed from the list.`, 'info');
        await loadStatus();
    } catch (err) {
        showToast(`Could not remove the project: ${err.message}`, 'error');
    }
}

function coreBadge(project) {
    if (project.coreState === 'current') return '<span class="badge badge-success">Up to date</span>';
    if (project.coreState === 'behind') return '<span class="badge badge-warning">Behind</span>';
    if (project.coreState === 'none') return '<span class="badge badge-muted">No core remote</span>';
    return '<span class="badge badge-muted">Unknown</span>';
}

function lastSyncCell(name) {
    const result = lastResults[name];
    if (!result) return '<span class="text-muted">-</span>';
    if (result.state === 'running') return '<span class="badge badge-info">Syncing...</span>';
    if (result.state === 'success') return '<span class="badge badge-success">Synced</span>';
    return `<span class="badge badge-error">Failed</span><div class="text-muted" style="font-size:11px;">${escapeHtml(result.message || '')}</div>`;
}

/**
 * Draws the summary line and the project table from statusData.
 */
function render() {
    const summary = document.getElementById('core-sync-summary');
    const tbody = document.getElementById('core-sync-table-body');
    const syncAllBtn = document.getElementById('btn-core-sync-all');
    const addBtn = document.getElementById('btn-core-sync-add');
    if (!statusData || !summary || !tbody) return;

    const projects = statusData.projects || [];
    const hasCoreRemote = projects.some(project => project.folderExists && project.coreState !== 'none');

    let coreText;
    if (projects.length === 0) {
        coreText = 'add a project to check it against core';
    } else if (statusData.coreHead) {
        coreText = `latest commit ${truncateHash(statusData.coreHead)}`;
    } else if (hasCoreRemote) {
        coreText = 'could not be reached to check for updates';
    } else {
        coreText = 'no listed project has a "core" remote';
    }
    summary.textContent = `${projects.length} project${projects.length === 1 ? '' : 's'}  |  Core: ${coreText}`;

    if (syncAllBtn) syncAllBtn.disabled = syncing || projects.length === 0;
    if (addBtn) addBtn.disabled = syncing;

    if (projects.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align:center;padding:24px;">
                    <span class="text-muted">No projects yet. Click "+ Add Project" and pick a project's working folder.</span>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = projects.map(project => {
        const safeName = escapeHtml(project.name);
        const folderText = `<span class="text-muted" style="font-size:11px;">${escapeHtml(project.folder)}</span>`;
        const folderCell = project.folderExists
            ? folderText
            : `<span class="badge badge-error">Not found</span><div>${folderText}</div>`;
        const branchCell = !project.folderExists
            ? '<span class="text-muted">-</span>'
            : project.branch === 'main'
                ? 'main'
                : `<span class="badge badge-warning">${escapeHtml(project.branch || 'detached')}</span>`;
        const changesCell = !project.folderExists
            ? '<span class="text-muted">-</span>'
            : project.localChanges === 0
                ? '<span class="text-muted">Clean</span>'
                : `${project.localChanges} file${project.localChanges === 1 ? '' : 's'}`;
        const note = project.note
            ? `<div class="text-muted" style="font-size:11px;">${escapeHtml(project.note)}</div>`
            : '';
        const syncDisabled = syncing || !project.canSync ? 'disabled' : '';
        const removeDisabled = syncing ? 'disabled' : '';

        return `
            <tr>
                <td><strong>${safeName}</strong></td>
                <td style="max-width:260px;" title="${escapeHtml(project.folder)}">${folderCell}</td>
                <td>${branchCell}</td>
                <td>${changesCell}</td>
                <td>${project.folderExists ? coreBadge(project) : '<span class="text-muted">-</span>'}</td>
                <td>${lastSyncCell(project.name)}</td>
                <td>
                    <button class="btn btn-sm btn-text" data-action="sync" data-repo="${safeName}" ${syncDisabled}>Sync</button>
                    <button class="btn btn-sm btn-text btn-danger" data-action="remove" data-repo="${safeName}" ${removeDisabled}>Remove</button>
                    ${note}
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * Syncs every project that can be synced and may be behind core. Projects
 * that are already up to date, or have no core remote, are skipped.
 */
function syncAll() {
    if (!statusData) return;
    const targets = (statusData.projects || [])
        .filter(project => project.canSync && project.coreState !== 'current' && project.coreState !== 'none')
        .map(project => project.name);

    if (targets.length === 0) {
        showToast('Nothing to sync: every project is up to date or cannot be synced.', 'info');
        return;
    }
    syncProjects(targets);
}

/**
 * Runs the core sync for the given projects, all at the same time. A failure
 * in one project does not stop the rest.
 * @param {string[]} names - Project names to sync
 */
async function syncProjects(names) {
    if (syncing || !names || names.length === 0) return;

    const confirmed = await window.api.confirm(
        'Sync Core',
        names.length === 1 ? `Sync core into ${names[0]}?` : `Sync core into ${names.length} projects?`,
        `${names.join(', ')}\n\nThis merges the latest core into each project's main branch and pushes the result to the DEV repository. Uncommitted work is stashed and restored.`
    );
    if (!confirmed) return;

    syncing = true;
    render();
    // The shared console refreshes every 3 seconds; refresh faster while a sync runs.
    const logTimer = setInterval(refreshLogConsole, 1000);

    let failed = 0;
    let finished = 0;
    const showProgress = () => {
        setStatus(
            names.length === 1
                ? `Syncing core into ${names[0]}...`
                : `Syncing core into ${names.length} projects (${finished} of ${names.length} done)...`,
            'busy'
        );
    };

    names.forEach((name) => { lastResults[name] = { state: 'running' }; });
    showProgress();
    render();

    // Each project is its own working folder, so the syncs do not affect each other.
    await Promise.all(names.map(async (name) => {
        try {
            const result = await window.api.runCoreSync(name);
            lastResults[name] = { state: result.success ? 'success' : 'failed', message: result.message };
            if (!result.success) failed++;
        } catch (err) {
            lastResults[name] = { state: 'failed', message: err.message };
            failed++;
        }
        finished++;
        showProgress();
        render();
    }));

    clearInterval(logTimer);
    refreshLogConsole();
    syncing = false;

    // Re-read branch, local changes and "behind" state now that the folders changed.
    await loadStatus();

    if (failed === 0) {
        showToast(names.length === 1 ? `${names[0]} synced with core.` : `${names.length} projects synced with core.`, 'success');
        setStatus('Core sync complete', 'success');
    } else {
        showToast(`Core sync finished: ${names.length - failed} succeeded, ${failed} failed. See the Log Console.`, 'error');
        setStatus('Core sync finished with errors', 'error');
    }
}
})();