(function () {
    'use strict';

    /**
     * History page logic.
     * Displays production commit history for a selected repository and branch.
     */

    let selectedRepo = '';
    let selectedBranch = '';

/**
 * Initializes the history page.
 */
window.pageInit = async function () {
    setStatus('Loading repositories...', 'busy');
    await loadRepoSelect();
    setupEventListeners();
    setStatus('Ready', 'success');
};

/**
 * Loads repositories into the dropdown.
 */
async function loadRepoSelect() {
    try {
        const repos = await window.api.getRepositories();
        const select = document.getElementById('history-repo-select');
        select.innerHTML = '<option value="">-- Select Repository --</option>' +
            repos.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('');
    } catch (err) {
        showToast('Failed to load repositories: ' + err.message, 'error');
    }
}

/**
 * Sets up event listeners for the dropdowns.
 */
function setupEventListeners() {
    const repoSelect = document.getElementById('history-repo-select');
    const branchSelect = document.getElementById('history-branch-select');
    const maxInput = document.getElementById('history-max-input');

    repoSelect.addEventListener('change', async () => {
        selectedRepo = repoSelect.value;
        selectedBranch = '';
        branchSelect.innerHTML = '<option value="">-- Select Branch --</option>';

        if (selectedRepo) {
            try {
                const branches = await window.api.getBranches(selectedRepo);
                branchSelect.innerHTML = '<option value="">-- Select Branch --</option>' +
                    branches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
            } catch (err) {
                showToast('Failed to load branches: ' + err.message, 'error');
            }
        }

        clearHistory();
    });

    branchSelect.addEventListener('change', () => {
        selectedBranch = branchSelect.value;
        if (selectedRepo && selectedBranch) {
            refreshHistory();
        } else {
            clearHistory();
        }
    });

    maxInput.addEventListener('change', () => {
        if (selectedRepo && selectedBranch) {
            refreshHistory();
        }
    });
}

/**
 * Clears the history table.
 */
function clearHistory() {
    const tbody = document.getElementById('history-body');
    tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:24px;">Select a repository and branch to view history.</td></tr>';
}

/**
 * Refreshes the production commit history.
 */
async function refreshHistory() {
    if (!selectedRepo || !selectedBranch) return;

    const maxCount = parseInt(document.getElementById('history-max-input').value, 10) || 50;
    const tbody = document.getElementById('history-body');
    tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:24px;">Loading...</td></tr>';

    try {
        const commits = await window.api.getHistory(selectedRepo, selectedBranch, maxCount);

        if (!commits || commits.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;"><span class="text-muted">No history available</span></td></tr>';
            return;
        }

        tbody.innerHTML = commits.map(c => `
            <tr>
                <td class="commit-hash" title="${escapeHtml(c.hash)}">${escapeHtml(truncateHash(c.hash))}</td>
                <td>${escapeHtml(c.author)}</td>
                <td>${escapeHtml(formatDate(c.date))}</td>
                <td style="max-width:350px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(c.message)}">${escapeHtml(c.message)}</td>
                <td class="text-muted" style="font-size:11px;">${escapeHtml(c.refs || '')}</td>
            </tr>
        `).join('');

        showToast(`Loaded ${commits.length} commit${commits.length !== 1 ? 's' : ''}`, 'info', 2000);
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-error" style="text-align:center;padding:24px;">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
}
    window.refreshHistory = refreshHistory;
})();
