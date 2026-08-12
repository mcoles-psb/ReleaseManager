(function () {
    'use strict';

    /**
     * Settings page logic.
     * Loads and saves application settings via IPC.
     */

    /**
     * Initializes the settings page: loads current settings from the main process.
     */
window.pageInit = async function () {
    setStatus('Loading settings...', 'busy');
    await loadSettings();
    setStatus('Settings loaded', 'success');
};

/**
 * Loads settings from the main process and populates the form fields.
 */
async function loadSettings() {
    try {
        const settings = await window.api.getSettings();

        document.getElementById('setting-dev-org').value = settings.devOrg || '';
        document.getElementById('setting-prod-org').value = settings.prodOrg || '';
        document.getElementById('setting-mirror-dir').value = settings.mirrorDirectory || '';
        document.getElementById('setting-default-branch').value = settings.defaultBranch || 'main';
        document.getElementById('setting-log-retention').value = settings.logRetentionDays || 30;
        document.getElementById('setting-git-path').value = settings.gitExecutable || 'git';
        document.getElementById('setting-confirm-promote').checked = settings.confirmBeforePromote !== false;
        document.getElementById('setting-confirm-revert').checked = settings.confirmBeforeRevert !== false;
    } catch (err) {
        showToast('Failed to load settings: ' + err.message, 'error');
    }
}

/**
 * Saves the current settings to the main process.
 */
async function saveSettings() {
    const settings = {
        devOrg: document.getElementById('setting-dev-org').value.trim(),
        prodOrg: document.getElementById('setting-prod-org').value.trim(),
        mirrorDirectory: document.getElementById('setting-mirror-dir').value.trim(),
        defaultBranch: document.getElementById('setting-default-branch').value.trim() || 'main',
        logRetentionDays: parseInt(document.getElementById('setting-log-retention').value, 10) || 30,
        gitExecutable: document.getElementById('setting-git-path').value.trim() || 'git',
        confirmBeforePromote: document.getElementById('setting-confirm-promote').checked,
        confirmBeforeRevert: document.getElementById('setting-confirm-revert').checked
    };

    setStatus('Saving settings...', 'busy');

    try {
        await window.api.saveSettings(settings);
        showToast('Settings saved successfully', 'success');
        setStatus('Settings saved', 'success');
    } catch (err) {
        showToast('Failed to save settings: ' + err.message, 'error');
        setStatus('Failed to save settings', 'error');
    }
}
    window.saveSettings = saveSettings;
})();
