(function () {
    'use strict';

    /**
     * Revert page logic.
     * Allows users to safely revert a production commit using git revert.
     * Displays recent production history for reference.
     */

    let selectedRepo = '';
    let selectedBranch = '';

/**
 * Initializes the revert page.
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
        const select = document.getElementById('revert-repo-select');
        select.innerHTML = '<option value="">-- Select Repository --</option>' +
            repos.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('');
    } catch (err) {
        showToast('Failed to load repositories: ' + err.message, 'error');
    }
}

/**
 * Sets up event listeners for the form controls.
 */
function setupEventListeners() {
    const repoSelect = document.getElementById('revert-repo-select');
    const branchSelect = document.getElementById('revert-branch-select');
    const commitInput = document.getElementById('revert-commit-input');
    const revertBtn = document.getElementById('revert-btn');

    repoSelect.addEventListener('change', async () => {
        selectedRepo = repoSelect.value;
        branchSelect.innerHTML = '<option value="">-- Select Branch --</option>';
        selectedBranch = '';
        updateRevertButton();

        if (selectedRepo) {
            try {
                const branches = await window.api.getBranches(selectedRepo);
                branchSelect.innerHTML = '<option value="">-- Select Branch --</option>' +
                    branches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
            } catch (err) {
                showToast('Failed to load branches: ' + err.message, 'error');
            }
        }

        document.getElementById('recent-history-body').innerHTML =
            '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:24px;">Select a repository and branch to view recent history.</td></tr>';
    });

    branchSelect.addEventListener('change', () => {
        selectedBranch = branchSelect.value;
        updateRevertButton();

        if (selectedRepo && selectedBranch) {
            refreshRecentHistory();
        }
    });

    commitInput.addEventListener('input', updateRevertButton);

    commitInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !revertBtn.disabled) {
            doRevert();
        }
    });

    revertBtn.addEventListener('click', doRevert);
}

/**
 * Updates the revert button state based on form completeness.
 */
function updateRevertButton() {
    const commitHash = document.getElementById('revert-commit-input').value.trim();
    document.getElementById('revert-btn').disabled = !(selectedRepo && selectedBranch && commitHash);
}

/**
 * Refreshes the recent production history table.
 */
async function refreshRecentHistory() {
    if (!selectedRepo || !selectedBranch) return;

    const tbody = document.getElementById('recent-history-body');
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:24px;">Loading...</td></tr>';

    try {
        const commits = await window.api.getHistory(selectedRepo, selectedBranch, 20);

        if (!commits || commits.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:24px;"><span class="text-muted">No history available</span></td></tr>';
            return;
        }

        tbody.innerHTML = commits.map(c => `
            <tr>
                <td class="commit-hash">${escapeHtml(truncateHash(c.hash))}</td>
                <td>${escapeHtml(c.author)}</td>
                <td>${escapeHtml(formatDate(c.date))}</td>
                <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.message)}</td>
            </tr>
        `).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-error" style="text-align:center;padding:24px;">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
}

    window.refreshRecentHistory = refreshRecentHistory;
})();

/**
 * Executes the revert operation after confirmation.
 */
async function doRevert() {
    const commitHash = document.getElementById('revert-commit-input').value.trim();

    const confirmed = await window.api.confirm(
        'Revert Commit',
        `Revert commit "${commitHash}" on "${selectedBranch}"?`,
        'This will create a new commit that reverses the changes. The original commit remains in history.'
    );

    if (!confirmed) return;

    setStatus('Reverting commit...', 'busy');
    document.getElementById('revert-btn').disabled = true;

    try {
        await window.api.revertCommit(selectedRepo, selectedBranch, commitHash);
        showToast(`Commit ${commitHash} reverted successfully`, 'success');
        setStatus('Revert completed', 'success');
        document.getElementById('revert-commit-input').value = '';
        updateRevertButton();
        await refreshRecentHistory();
    } catch (err) {
        showToast(`Revert failed: ${err.message}`, 'error');
        setStatus('Revert failed', 'error');
    } finally {
        document.getElementById('revert-btn').disabled = false;
    }
}