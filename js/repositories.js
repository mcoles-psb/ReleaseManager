(function () {
    'use strict';

    /**
     * Repository Manager page logic.
     * Manages Git bare mirror repositories: add, remove, refresh, verify.
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
        
        return `
            <tr>
                <td><strong>${escapeHtml(repo.name)}</strong></td>
                <td>${escapeHtml(devOrg)}</td>
                <td>${escapeHtml(prodOrg)}</td>
                <td>${escapeHtml(repo.defaultBranch || 'main')}</td>
                <td>${statusBadge}</td>
                <td class="text-muted">-</td>
                <td>
                    <button class="btn btn-sm btn-text" onclick="refreshRepository('${escapeHtml(repo.name)}')">Refresh</button>
                    <button class="btn btn-sm btn-text" onclick="verifyRepository('${escapeHtml(repo.name)}')">Verify</button>
                    <button class="btn btn-sm btn-text btn-danger" onclick="removeRepository('${escapeHtml(repo.name)}')">Remove</button>
                </td>
            </tr>
        `;
    }).join('');
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
                <button class="dialog-close" onclick="this.closest('.dialog-overlay').remove()">&times;</button>
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
                <button class="btn btn-secondary" onclick="this.closest('.dialog-overlay').remove()">Cancel</button>
                <button class="btn btn-primary" id="add-repo-confirm">Clone Mirror</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Focus the first input
    setTimeout(() => document.getElementById('new-repo-name').focus(), 100);

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
 * Removes a repository after user confirmation.
 * @param {string} repoName - The repository name (e.g., "PSBUniverse-core")
 */
async function removeRepository(repoName) {
    console.log('[renderer] removeRepository called with:', repoName);
    const confirmed = await window.api.confirm(
        'Remove Repository',
        `Are you sure you want to remove "${repoName}"?`,
        'This will permanently delete the mirror repository from disk. This action cannot be undone.'
    );

    if (!confirmed) return;

    showProgress('Removing Repository', `Removing ${repoName}...`);

    try {
        await window.api.removeRepository(`${repoName}.git`);
        hideProgress();
        showToast(`Repository "${repoName}" removed`, 'success');
        await loadRepositories();
    } catch (err) {
        hideProgress();
        showToast(`Failed to remove repository: ${err.message}`, 'error');
    }
}

/**
 * Verifies a repository's remote configuration.
 * @param {string} repoName - The repository name (e.g., "PSBUniverse-core")
 */
async function verifyRepository(repoName) {
    console.log('[renderer] verifyRepository called with:', repoName);
    setStatus(`Verifying ${repoName}...`, 'busy');

    try {
        const result = await window.api.verifyRepository(`${repoName}.git`);
        console.log('[renderer] verifyRepository result:', result);
        
        if (result.valid) {
            showToast(`Repository "${repoName}" is properly configured`, 'success');
            setStatus('Verification successful', 'success');
        } else {
            showToast(`Verification failed: ${result.error}`, 'error');
            setStatus('Verification failed', 'error');
        }
    } catch (err) {
        showToast(`Failed to verify repository: ${err.message}`, 'error');
        setStatus('Verification failed', 'error');
    }
}

/**
 * Refreshes a repository by fetching from origin.
 * @param {string} repoName - The repository name (e.g., "PSBUniverse-core")
 */
async function refreshRepository(repoName) {
    console.log('[renderer] refreshRepository called with:', repoName);
    setStatus(`Refreshing ${repoName}...`, 'busy');
    showProgress('Refreshing Repository', `Fetching latest from ${repoName}...`);

    try {
        await window.api.refreshRepository(`${repoName}.git`);
        console.log('[renderer] refreshRepository completed');
        hideProgress();
        showToast(`Repository "${repoName}" refreshed successfully`, 'success');
        setStatus('Refresh complete', 'success');
        await loadRepositories();
    } catch (err) {
        console.error('[renderer] refreshRepository failed:', err);
        hideProgress();
        showToast(`Failed to refresh repository: ${err.message}`, 'error');
        setStatus('Refresh failed', 'error');
    }
}

    window.refreshRepository = refreshRepository;
    window.verifyRepository = verifyRepository;
    window.removeRepository = removeRepository;
})();
