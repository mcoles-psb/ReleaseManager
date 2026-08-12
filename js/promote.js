(function () {
    'use strict';

    /**
     * Promote page logic.
     * Allows users to select a repository and branch, view pending changes
     * between DEV and PROD, and promote branches to production.
     */

    let selectedRepo = '';
    let selectedBranch = '';

/**
 * Initializes the promote page: loads repositories into the dropdown.
 */
window.pageInit = async function () {
    setStatus('Loading repositories...', 'busy');
    await loadRepoSelect();
    setupEventListeners();
    setStatus('Ready to promote', 'success');
};

/**
 * Loads repositories into the repository dropdown.
 */
async function loadRepoSelect() {
    try {
        const repos = await window.api.getRepositories();
        const select = document.getElementById('promote-repo-select');
        select.innerHTML = '<option value="">-- Select Repository --</option>' +
            repos.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('');
    } catch (err) {
        showToast('Failed to load repositories: ' + err.message, 'error');
    }
}

/**
 * Sets up event listeners for the dropdowns and promote button.
 */
function setupEventListeners() {
    const repoSelect = document.getElementById('promote-repo-select');
    const branchSelect = document.getElementById('promote-branch-select');
    const promoteBtn = document.getElementById('promote-btn');

    repoSelect.addEventListener('change', async () => {
        selectedRepo = repoSelect.value;
        selectedBranch = '';
        branchSelect.innerHTML = '<option value="">-- Select Branch --</option>';
        promoteBtn.disabled = true;

        if (selectedRepo) {
            await populateBranchOptions(repoSelect.value, branchSelect);
        }

        document.getElementById('dev-table-body').innerHTML =
            '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:24px;">Select a branch to see DEV history.</td></tr>';
        document.getElementById('prod-table-body').innerHTML =
            '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:24px;">Select a branch to see PROD history.</td></tr>';
    });

    branchSelect.addEventListener('change', () => {
        selectedBranch = branchSelect.value;
        promoteBtn.disabled = !selectedBranch;

        if (selectedBranch && selectedRepo) {
            refreshCompareTables();
        } else {
            document.getElementById('dev-table-body').innerHTML =
                '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:24px;">Select a branch to see DEV history.</td></tr>';
            document.getElementById('prod-table-body').innerHTML =
                '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:24px;">Select a branch to see PROD history.</td></tr>';
        }
    });

    promoteBtn.addEventListener('click', promoteBranch);
}

/**
 * Populates the branch select with branches fetched from the repository.
 */
async function populateBranchOptions(repoName, select) {
    select.innerHTML = '<option value="">-- Select Branch --</option>';
    try {
        const branches = await window.api.getBranches(repoName);
        select.innerHTML += branches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
    } catch (err) {
        showToast('Failed to load branches: ' + err.message, 'error');
    }
}

/**
 * Refreshes the DEV and PROD compare tables side by side.
 */
async function refreshCompareTables() {
    if (!selectedRepo || !selectedBranch) return;

    const devBody = document.getElementById('dev-table-body');
    const prodBody = document.getElementById('prod-table-body');
    devBody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:24px;">Loading...</td></tr>';
    prodBody.innerHTML = '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:24px;">Loading...</td></tr>';

    try {
        const [devCommits, prodCommits, compareResult] = await Promise.all([
            window.api.getDevHistory(selectedRepo, selectedBranch, 50),
            window.api.getHistory(selectedRepo, selectedBranch, 50),
            window.api.getCompare(selectedRepo, selectedBranch)
        ]);

        const pendingHashes = new Set((compareResult.commits || []).map(c => c.hash));

        if (!devCommits || devCommits.length === 0) {
            devBody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;"><span class="text-muted">No history available</span></td></tr>';
        } else {
            devBody.innerHTML = devCommits.map(c => {
                const isPending = pendingHashes.has(c.hash);
                const statusBadge = isPending
                    ? '<span class="badge badge-warning">Pending</span>'
                    : '<span class="badge badge-success">Promoted</span>';
                return `
                    <tr>
                        <td>${statusBadge}</td>
                        <td class="commit-hash">${escapeHtml(truncateHash(c.hash))}</td>
                        <td>${escapeHtml(c.author)}</td>
                        <td>${escapeHtml(formatDate(c.date))}</td>
                        <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.message)}</td>
                    </tr>
                `;
            }).join('');
        }

        if (!prodCommits || prodCommits.length === 0) {
            prodBody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:24px;"><span class="text-muted">No history available</span></td></tr>';
        } else {
            prodBody.innerHTML = prodCommits.map(c => `
                <tr>
                    <td class="commit-hash">${escapeHtml(truncateHash(c.hash))}</td>
                    <td>${escapeHtml(c.author)}</td>
                    <td>${escapeHtml(formatDate(c.date))}</td>
                    <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.message)}</td>
                </tr>
            `).join('');
        }
    } catch (err) {
        devBody.innerHTML = `<tr><td colspan="5" class="text-error" style="text-align:center;padding:24px;">Error: ${escapeHtml(err.message)}</td></tr>`;
        prodBody.innerHTML = `<tr><td colspan="4" class="text-error" style="text-align:center;padding:24px;">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
}

/**
 * Promotes the selected branch to PROD after confirmation.
 */
async function promoteBranch() {
    if (!selectedRepo || !selectedBranch) return;

    const confirmed = await window.api.confirm(
        'Promote to PROD',
        `Promote branch "${selectedBranch}" from "${selectedRepo.replace('.git', '')}" to PROD?`,
        'This will push the latest changes from DEV to PROD.'
    );

    if (!confirmed) return;

    setStatus('Promoting branch...', 'busy');
    document.getElementById('promote-btn').disabled = true;

    try {
        await window.api.promoteBranch(selectedRepo, selectedBranch);
        showToast(`Branch "${selectedBranch}" promoted to PROD successfully`, 'success');
        setStatus('Promotion completed', 'success');
        await refreshCompareTables();
    } catch (err) {
        showToast(`Promotion failed: ${err.message}`, 'error');
        setStatus('Promotion failed', 'error');
    } finally {
        document.getElementById('promote-btn').disabled = false;
    }
}
    window.refreshCompareTables = refreshCompareTables;
})();
