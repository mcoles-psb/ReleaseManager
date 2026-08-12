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
        return `
            <tr>
                <td><strong>${escapeHtml(repoName)}</strong></td>
                <td class="text-muted">-</td>
                <td><span class="badge badge-success">Mirror</span></td>
                <td>
                    <button class="btn btn-sm btn-text" onclick="removeRepository('${escapeHtml(repoName)}')">Remove</button>
                </td>
            </tr>
        `;
    }).join('');
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
                <button class="dialog-close" onclick="this.closest('.dialog-overlay').remove()">&times;</button>
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
                <button class="btn btn-secondary" onclick="this.closest('.dialog-overlay').remove()">Cancel</button>
                <button class="btn btn-primary" id="add-repo-confirm">Add Repository</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Focus the input
    setTimeout(() => document.getElementById('new-repo-url').focus(), 100);

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
 * Removes a repository after user confirmation.
 * @param {string} repoName - The repository name (e.g., "repo.git")
 */
async function removeRepository(repoName) {
    const cleanName = String(repoName).replace('.git', '');
    const confirmed = await window.api.confirm(
        'Remove Repository',
        `Are you sure you want to remove "${cleanName}"?`,
        'This will permanently delete the mirror repository from disk. This action cannot be undone.'
    );

    if (!confirmed) return;

    showProgress('Removing Repository', `Removing ${cleanName}...`);

    try {
        await window.api.removeRepository(cleanName);
        hideProgress();
        showToast('Repository removed', 'success');
        await loadRepositories();
    } catch (err) {
        hideProgress();
        showToast(`Failed to remove repository: ${err.message}`, 'error');
    }
}

    window.showAddRepositoryDialog = showAddRepositoryDialog;
    window.removeRepository = removeRepository;
})();
