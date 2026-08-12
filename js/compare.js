(function () {
    'use strict';

    /**
     * Compare page logic.
     * Shows commits that are in DEV (origin) but not yet in PROD (prod).
     */

    let selectedRepo = '';
    let selectedBranch = '';

/**
 * Initializes the compare page.
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
        const select = document.getElementById('compare-repo-select');
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
    const repoSelect = document.getElementById('compare-repo-select');
    const branchSelect = document.getElementById('compare-branch-select');

    repoSelect.addEventListener('change', async () => {
        selectedRepo = repoSelect.value;
        branchSelect.innerHTML = '<option value="">-- Select Branch --</option>';
        selectedBranch = '';

        if (selectedRepo) {
            try {
                const branches = await window.api.getBranches(selectedRepo);
                branchSelect.innerHTML = '<option value="">-- Select Branch --</option>' +
                    branches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
            } catch (err) {
                showToast('Failed to load branches: ' + err.message, 'error');
            }
        }

        clearCompareResults();
    });

    branchSelect.addEventListener('change', () => {
        selectedBranch = branchSelect.value;
        if (selectedRepo && selectedBranch) {
            refreshCompare();
        } else {
            clearCompareResults();
        }
    });
}

/**
 * Clears the compare results table.
 */
function clearCompareResults() {
    const tbody = document.getElementById('compare-result-body');
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:24px;">Select a repository and branch to compare.</td></tr>';
    document.getElementById('compare-summary').classList.add('hidden');
}

/**
 * Refreshes the compare results showing commits ahead of PROD.
 */
async function refreshCompare() {
    if (!selectedRepo || !selectedBranch) return;

    const tbody = document.getElementById('compare-result-body');
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:24px;">Loading...</td></tr>';

    try {
        const result = await window.api.getCompare(selectedRepo, selectedBranch);
        const commits = result.commits || [];

        if (!commits || commits.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:24px;"><span class="badge badge-success">Up to date - no pending changes</span></td></tr>';
            document.getElementById('compare-summary-card').classList.add('hidden');
            document.getElementById('compare-summary').classList.add('hidden');
            return;
        }

        // Populate table
        tbody.innerHTML = commits.map(c => `
            <tr>
                <td class="commit-hash">${escapeHtml(truncateHash(c.hash))}</td>
                <td>${escapeHtml(c.author)}</td>
                <td>${escapeHtml(formatDate(c.date))}</td>
                <td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.message)}</td>
            </tr>
        `).join('');

        // Populate summary card
        const summaryCard = document.getElementById('compare-summary-card');
        summaryCard.classList.remove('hidden');
        
        document.getElementById('summary-repo-name').textContent = selectedRepo;
        document.getElementById('summary-branch').textContent = selectedBranch;
        
        if (result.devLatest) {
            document.getElementById('summary-dev-commit').textContent = 
                `${truncateHash(result.devLatest.abbreviatedHash)} - ${result.devLatest.message}`;
        } else {
            document.getElementById('summary-dev-commit').textContent = 'N/A';
        }
        
        if (result.prodLatest) {
            document.getElementById('summary-prod-commit').textContent = 
                `${truncateHash(result.prodLatest.abbreviatedHash)} - ${result.prodLatest.message}`;
        } else {
            document.getElementById('summary-prod-commit').textContent = 'N/A (no PROD commits yet)';
        }
        
        document.getElementById('summary-commit-count').textContent = result.commitCount;
        document.getElementById('summary-changed-files').textContent = result.changedFiles;
        
        const statusEl = document.getElementById('summary-status');
        if (result.commitCount > 0) {
            statusEl.innerHTML = '<span class="badge badge-success">Ready to Promote</span>';
        } else {
            statusEl.innerHTML = '<span class="badge badge-secondary">Up to Date</span>';
        }

        // Show summary text
        const summary = document.getElementById('compare-summary');
        summary.classList.remove('hidden');
        document.getElementById('compare-count').textContent =
            `${commits.length} commit${commits.length !== 1 ? 's' : ''} ahead of PROD.`;
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-error" style="text-align:center;padding:24px;">Error: ${escapeHtml(err.message)}</td></tr>`;
        document.getElementById('compare-summary-card').classList.add('hidden');
        document.getElementById('compare-summary').classList.add('hidden');
    }
}

    window.refreshCompare = refreshCompare;
})();
