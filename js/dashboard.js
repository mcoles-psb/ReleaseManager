(function () {
    'use strict';

    /**
     * Dashboard page logic.
     * Displays repository overview, stats, and provides quick actions.
     */

    let repoData = [];

/**
 * Initializes the dashboard page: loads repositories and populates the table.
 */
window.pageInit = async function () {
    setStatus('Loading repositories...', 'busy');
    await loadRepositories();
    setStatus('Dashboard ready', 'success');

    const addBtn = document.getElementById('btn-add-repo');
    if (addBtn) {
        addBtn.addEventListener('click', showAddRepositoryDialog);
    }

    attachRepoTableHandlers();
};

/**
 * Fetches the list of repositories from the main process and renders the table.
 */
async function loadRepositories() {
    try {
        repoData = await window.api.getRepositories();
        renderRepoTable(repoData);
        updateStats(repoData);
    } catch (err) {
        console.error('Failed to load repositories:', err);
        document.getElementById('repo-table-body').innerHTML =
            `<tr><td colspan="4" class="text-error" style="text-align:center;padding:24px;">Error: ${escapeHtml(err.message)}</td></tr>`;
        setStatus('Failed to load repositories', 'error');
    }
}

/**
 * Renders the repository table with the given repository list.
 * @param {string[]} repos - Array of repository names
 */
function renderRepoTable(repos) {
    const tbody = document.getElementById('repo-table-body');

    if (!repos || repos.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" style="text-align:center;padding:24px;">
                    <span class="text-muted">No repositories found. Add a repository to get started.</span>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = repos.map(repo => {
        const repoName = repo.name || repo;
        const safeName = escapeHtml(repoName);

        // The Delete button carries the repository name in a data attribute
        // instead of an inline onclick="..." handler, which the app's
        // Content-Security-Policy blocks. See attachRepoTableHandlers() below.
        return `
            <tr>
                <td><strong>${safeName}</strong></td>
                <td class="text-muted">-</td>
                <td><span class="badge badge-success">Mirror</span></td>
                <td>
                    <button class="btn btn-sm btn-text btn-danger" data-action="delete" data-repo="${safeName}">Delete</button>
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * Wires up the Delete button in the dashboard table.
 *
 * The listener sits on the table body so that rows re-rendered after a
 * delete are handled automatically without re-binding.
 */
function attachRepoTableHandlers() {
    const tbody = document.getElementById('repo-table-body');
    if (!tbody) return;

    tbody.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action="delete"]');
        if (!button) return;

        const repoName = button.dataset.repo;
        if (repoName) {
            deleteRepository(repoName);
        }
    });
}

/**
 * Updates the statistics cards with repository data.
 * @param {string[]} repos - Array of repository names
 */
function updateStats(repos) {
    document.getElementById('stat-repos').textContent = repos ? repos.length : 0;
    document.getElementById('stat-branches').textContent = '-';
    document.getElementById('stat-last-promotion').textContent = 'N/A';
}

/**
 * Shows a dialog to add a new repository by URL.
 */
function showAddRepositoryDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
        <div class="dialog dialog-sm">
            <div class="dialog-header">
                <h3>Add Repository</h3>
                <button class="dialog-close" id="add-repo-close">&times;</button>
            </div>
            <div class="dialog-body">
                <div class="form-group">
                    <label class="form-label">GitHub Repository URL</label>
                    <input type="text" class="form-input" id="new-repo-url"
                        placeholder="https://github.com/PSBUniverse-DEV/repo.git">
                </div>
                <p class="text-muted" style="font-size:11px;">
                    Enter the DEV organization repository URL. The mirror will be cloned automatically.
                </p>
            </div>
            <div class="dialog-footer">
                <button class="btn btn-secondary" id="add-repo-cancel">Cancel</button>
                <button class="btn btn-primary" id="add-repo-confirm">Add Repository</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Focus the input
    setTimeout(() => document.getElementById('new-repo-url').focus(), 100);

    // The close (×) and Cancel buttons dismiss the dialog without adding.
    // These use addEventListener because inline onclick handlers are blocked by
    // the app's Content-Security-Policy.
    overlay.querySelector('#add-repo-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#add-repo-cancel').addEventListener('click', () => overlay.remove());

    // Handle confirm
    document.getElementById('add-repo-confirm').addEventListener('click', async () => {
        const url = document.getElementById('new-repo-url').value.trim();
        if (!url) {
            showToast('Please enter a repository URL', 'warning');
            return;
        }

        overlay.remove();
        showProgress('Adding Repository', `Cloning ${url}...`);

        try {
            await window.api.addRepository(url);
            hideProgress();
            showToast('Repository added successfully', 'success');
            await loadRepositories();
        } catch (err) {
            hideProgress();
            showToast(`Failed to add repository: ${err.message}`, 'error');
        }
    });

    // Handle Enter key
    document.getElementById('new-repo-url').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('add-repo-confirm').click();
        }
    });
}

/**
 * Deletes a repository after user confirmation: removes the cloned mirror
 * from disk and drops it from the saved list.
 * @param {string} repoName - The repository name (e.g., "PSBUniverse-core")
 */
async function deleteRepository(repoName) {
    const confirmed = await window.api.confirm(
        'Delete Repository',
        `Delete "${repoName}"?`,
        'This permanently deletes the cloned mirror folder from disk and removes the repository from the saved list. This cannot be undone.'
    );

    if (!confirmed) return;

    showProgress('Deleting Repository', `Deleting ${repoName}...`);

    try {
        await window.api.deleteRepository(repoName);
        hideProgress();
        showToast('Repository deleted', 'success');
        await loadRepositories();
    } catch (err) {
        hideProgress();
        showToast(`Failed to delete repository: ${err.message}`, 'error');
    }
}
})();
