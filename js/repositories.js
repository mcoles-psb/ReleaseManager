(function () {
    'use strict';

    /**
     * Repository Manager page logic.
     * Manages Git bare mirror repositories: add, refetch, delete.
     */

    let repoData = [];

/**
 * Initializes the repository manager page: loads repositories and populates the table.
 */
window.pageInit = async function () {
    setStatus('Loading repositories...', 'busy');
    await loadRepositories();
    setStatus('Repository Manager ready', 'success');

    // Attach event listeners after page loads
    const addBtn = document.getElementById('btn-add-repo');
    if (addBtn) {
        addBtn.addEventListener('click', showAddRepositoryDialog);
    }
    const scanBtn = document.getElementById('btn-scan-repos');
    if (scanBtn) {
        scanBtn.addEventListener('click', scanForMirrors);
    }

    // Handle Refetch / Delete for every row in the table
    attachRepoTableHandlers();
};

/**
 * Scans the GitHubPromotion directory for existing mirror repositories
 * and registers any that aren't in the configuration.
 */
async function scanForMirrors() {
    setStatus('Scanning for existing mirrors...', 'busy');
    showProgress('Scanning', 'Looking for existing mirror repositories...');

    try {
        const result = await window.api.scanRepositories();
        hideProgress();

        if (result.added.length > 0) {
            showToast(`Found and registered ${result.added.length} mirror(s): ${result.added.join(', ')}`, 'success');
        } else {
            showToast('No new mirrors found. All mirrors are already registered.', 'info');
        }

        setStatus('Scan complete', 'success');
        await loadRepositories();
    } catch (err) {
        hideProgress();
        showToast(`Failed to scan for mirrors: ${err.message}`, 'error');
        setStatus('Scan failed', 'error');
    }
}

/**
 * Fetches the list of repositories from the main process and renders the table.
 */
async function loadRepositories() {
    console.log('[renderer] loadRepositories called');
    try {
        repoData = await window.api.getRepositories();
        console.log('[renderer] getRepositories returned:', repoData);
        renderRepoTable(repoData);
    } catch (err) {
        console.error('[renderer] Failed to load repositories:', err);
        document.getElementById('repo-table-body').innerHTML =
            `<tr><td colspan="7" class="text-error" style="text-align:center;padding:24px;">Error: ${escapeHtml(err.message)}</td></tr>`;
        setStatus('Failed to load repositories', 'error');
    }
}

/**
 * Renders the repository table with the given repository list.
 * @param {Array} repos - Array of repository objects
 */
function renderRepoTable(repos) {
    const tbody = document.getElementById('repo-table-body');

    if (!repos || repos.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align:center;padding:24px;">
                    <span class="text-muted">No repositories configured. Click "Add Repository" to get started.</span>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = repos.map(repo => {
        const devOrg = extractOrgFromUrl(repo.devRepo);
        const prodOrg = extractOrgFromUrl(repo.prodRepo);
        const statusBadge = getStatusBadge(repo.status, repo.enabled);
        const safeName = escapeHtml(repo.name);

        // The action buttons carry the repository name in a data attribute
        // rather than in an inline onclick="..." handler. index.html sets a
        // strict Content-Security-Policy which blocks inline handlers, so they
        // would silently do nothing. See attachRepoTableHandlers() below.
        return `
            <tr>
                <td><strong>${safeName}</strong></td>
                <td>${escapeHtml(devOrg)}</td>
                <td>${escapeHtml(prodOrg)}</td>
                <td>${escapeHtml(repo.defaultBranch || 'main')}</td>
                <td>${statusBadge}</td>
                <td class="text-muted">-</td>
                <td>
                    <button class="btn btn-sm btn-text" data-action="refetch" data-repo="${safeName}">Refetch</button>
                    <button class="btn btn-sm btn-text btn-danger" data-action="delete" data-repo="${safeName}">Delete</button>
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * Wires up the Refetch / Delete buttons in the repository table.
 *
 * The listener is attached to the table body once (rather than to each button)
 * because the table is rebuilt from scratch every time the repository list is
 * loaded. Listening on the parent means newly rendered rows are handled
 * automatically, with no need to re-bind after every refetch.
 */
function attachRepoTableHandlers() {
    const tbody = document.getElementById('repo-table-body');
    if (!tbody) return;

    tbody.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;

        // dataset returns the attribute value already decoded by the browser,
        // so this is the original repository name (not the HTML-escaped form).
        const repoName = button.dataset.repo;
        if (!repoName) return;

        switch (button.dataset.action) {
            case 'refetch':
                refetchRepository(repoName);
                break;
            case 'delete':
                deleteRepository(repoName);
                break;
        }
    });
}

/**
 * Returns a status badge HTML based on repository status.
 * @param {string} status - Repository status
 * @param {boolean} enabled - Whether repository is enabled
 * @returns {string} HTML badge
 */
function getStatusBadge(status, enabled) {
    if (status === 'cloning') {
        return '<span class="badge badge-info">🔵 Cloning</span>';
    }
    if (status === 'configuring') {
        return '<span class="badge badge-warning">🟠 Configuring</span>';
    }
    if (status === 'failed') {
        return '<span class="badge badge-error">🔴 Failed</span>';
    }
    if (status === 'fetch_required') {
        return '<span class="badge badge-warning">🟡 Fetch Required</span>';
    }
    if (enabled === false) {
        return '<span class="badge badge-muted">⚪ Disabled</span>';
    }
    if (status === 'ready') {
        return '<span class="badge badge-success">🟢 Ready</span>';
    }
    return '<span class="badge badge-muted">⚪ Not Configured</span>';
}

/**
 * Extracts the organization name from a GitHub URL.
 * @param {string} url - GitHub repository URL
 * @returns {string} Organization name
 */
function extractOrgFromUrl(url) {
    if (!url) return '-';
    // Handle formats: git@github.com:org/repo.git or https://github.com/org/repo.git
    const match = url.match(/github\.com[:/]([^/]+)/);
    return match ? match[1] : url;
}

/**
 * Shows a dialog to add a new repository.
 */
function showAddRepositoryDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
        <div class="dialog dialog-md">
            <div class="dialog-header">
                <h3>Add Repository</h3>
                <button class="dialog-close" id="add-repo-close">&times;</button>
            </div>
            <div class="dialog-body">
                <div class="form-group">
                    <label class="form-label">Repository Name</label>
                    <input type="text" class="form-input" id="new-repo-name"
                        placeholder="PSBUniverse-core">
                </div>
                <div class="form-group">
                    <label class="form-label">DEV Repository URL</label>
                    <input type="text" class="form-input" id="new-repo-dev-url"
                        placeholder="https://github.com/PSBUniverse-DEV/PSBUniverse-core.git">
                </div>
                <div class="form-group">
                    <label class="form-label">PROD Repository URL</label>
                    <input type="text" class="form-input" id="new-repo-prod-url"
                        placeholder="https://github.com/PSBUniverse-PROD/PSBUniverse-core.git">
                </div>
                <div class="form-group">
                    <label class="form-label">Default Branch</label>
                    <input type="text" class="form-input" id="new-repo-branch"
                        placeholder="main" value="main">
                </div>
                <p class="text-muted" style="font-size:11px; margin-top:8px;">
                    The repository will be cloned as a bare mirror into GitHubPromotion and configured with both DEV and PROD remotes.
                </p>
            </div>
            <div class="dialog-footer">
                <button class="btn btn-secondary" id="add-repo-cancel">Cancel</button>
                <button class="btn btn-primary" id="add-repo-confirm">Clone Mirror</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Focus the first input
    setTimeout(() => document.getElementById('new-repo-name').focus(), 100);

    // The close (×) and Cancel buttons dismiss the dialog without cloning.
    // These use addEventListener because inline onclick handlers are blocked by
    // the app's Content-Security-Policy.
    overlay.querySelector('#add-repo-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#add-repo-cancel').addEventListener('click', () => overlay.remove());

    // Auto-fill DEV/PROD URLs when repository name changes
    const devUrlInput = document.getElementById('new-repo-dev-url');
    const prodUrlInput = document.getElementById('new-repo-prod-url');
    const repoNameInput = document.getElementById('new-repo-name');

    repoNameInput.addEventListener('input', () => {
        const repoName = repoNameInput.value.trim();
        if (!repoName) return;
        devUrlInput.value = `https://github.com/PSBUniverse-DEV/${repoName}.git`;
        prodUrlInput.value = `https://github.com/PSBUniverse-PROD/${repoName}.git`;
    });

    // Handle confirm
    document.getElementById('add-repo-confirm').addEventListener('click', async () => {
        const repoName = document.getElementById('new-repo-name').value.trim();
        const devRepoUrl = document.getElementById('new-repo-dev-url').value.trim();
        const prodRepoUrl = document.getElementById('new-repo-prod-url').value.trim();
        const defaultBranch = document.getElementById('new-repo-branch').value.trim() || 'main';

        // Validation
        if (!repoName || !devRepoUrl || !prodRepoUrl) {
            showToast('Please fill in all required fields', 'warning');
            return;
        }

        overlay.remove();
        showProgress('Adding Repository', `Cloning ${repoName} as bare mirror...`);

        try {
            await window.api.addRepository(repoName, devRepoUrl, prodRepoUrl);
            hideProgress();
            showToast(`Repository "${repoName}" added successfully`, 'success');
            await loadRepositories();
        } catch (err) {
            hideProgress();
            showToast(`Failed to add repository: ${err.message}`, 'error');
        }
    });

    // Handle Enter key on inputs
    const inputs = overlay.querySelectorAll('input');
    inputs.forEach((input, index) => {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (index < inputs.length - 1) {
                    inputs[index + 1].focus();
                } else {
                    document.getElementById('add-repo-confirm').click();
                }
            }
        });
    });
}

/**
 * Deletes a repository after user confirmation.
 *
 * This removes the cloned mirror from GitHubPromotion AND drops the
 * repository from the saved list, so it will not reappear. It only comes
 * back if the user explicitly clones it again (Add Repository) or refetches
 * it after re-adding it.
 * @param {string} repoName - The repository name (e.g., "PSBUniverse-core")
 */
async function deleteRepository(repoName) {
    const confirmed = await window.api.confirm(
        'Delete Repository',
        `Delete "${repoName}"?`,
        'This permanently deletes the cloned mirror folder from disk and removes the repository from the saved list. You can clone it again later with Add Repository. This cannot be undone.'
    );

    if (!confirmed) return;

    showProgress('Deleting Repository', `Deleting ${repoName}...`);

    try {
        await window.api.deleteRepository(`${repoName}.git`);
        hideProgress();
        showToast(`Repository "${repoName}" deleted`, 'success');
        await loadRepositories();
    } catch (err) {
        hideProgress();
        showToast(`Failed to delete repository: ${err.message}`, 'error');
    }
}

/**
 * Refetches a single repository: clones its mirror if it is missing from
 * disk, then fetches the latest from DEV and PROD.
 * @param {string} repoName - The repository name (e.g., "PSBUniverse-core")
 */
async function refetchRepository(repoName) {
    setStatus(`Refetching ${repoName}...`, 'busy');
    showProgress('Refetching Repository', `Fetching latest for ${repoName}...`);

    try {
        const result = await window.api.refetchRepository(`${repoName}.git`);
        hideProgress();

        if (result.cloned) {
            showToast(`"${repoName}" was missing and has been cloned and fetched`, 'success');
        } else {
            showToast(`"${repoName}" refetched successfully`, 'success');
        }
        setStatus('Refetch complete', 'success');
        await loadRepositories();
    } catch (err) {
        hideProgress();
        showToast(`Failed to refetch repository: ${err.message}`, 'error');
        setStatus('Refetch failed', 'error');
    }
}
})();
