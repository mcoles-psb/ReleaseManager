/**
 * Shared utility functions used across all pages.
 * Provides toast notifications, dialog management, status updates,
 * and log console management.
 */

// ─── Toast Notifications ─────────────────────────────────────────────────────

/**
 * Shows a toast notification in the bottom-right corner.
 * @param {string} message - The message to display
 * @param {'success'|'error'|'info'|'warning'} type - Toast type
 * @param {number} duration - Auto-dismiss time in ms (0 = no auto-dismiss)
 */
function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    if (duration > 0) {
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
}

// ─── Progress Dialog ─────────────────────────────────────────────────────────

/**
 * Shows the progress dialog with an indeterminate progress bar.
 * @param {string} title - Dialog title
 * @param {string} message - Status message
 */
function showProgress(title, message) {
    document.getElementById('progress-title').textContent = title || 'Processing...';
    document.getElementById('progress-message').textContent = message || 'Please wait...';
    document.getElementById('progress-dialog').classList.remove('hidden');
}

/**
 * Updates the progress message without closing the dialog.
 * @param {string} message - New status message
 */
function updateProgress(message) {
    document.getElementById('progress-message').textContent = message;
}

/**
 * Hides the progress dialog.
 */
function hideProgress() {
    document.getElementById('progress-dialog').classList.add('hidden');
}

// ─── Confirm Dialog ──────────────────────────────────────────────────────────

let confirmCallback = null;

/**
 * Shows a confirmation dialog with customizable title, message, and detail.
 * @param {string} title - Dialog title
 * @param {string} message - Main confirmation message
 * @param {string} detail - Optional detail text
 * @param {Function} onConfirm - Callback when user confirms
 */
function showConfirmDialog(title, message, detail, onConfirm) {
    document.getElementById('confirm-title').textContent = title || 'Confirm';
    document.getElementById('confirm-message').textContent = message || 'Are you sure?';
    document.getElementById('confirm-detail').textContent = detail || '';
    confirmCallback = onConfirm;

    const confirmBtn = document.getElementById('confirm-btn');
    confirmBtn.onclick = function () {
        // Grab the callback BEFORE closing the dialog. closeConfirmDialog()
        // clears it, so reading it afterwards would always see null and the
        // caller's action would never run.
        const callback = confirmCallback;
        closeConfirmDialog();
        if (typeof callback === 'function') {
            callback();
        }
    };

    document.getElementById('confirm-dialog').classList.remove('hidden');
}

/**
 * Closes the confirmation dialog without confirming.
 */
function closeConfirmDialog() {
    document.getElementById('confirm-dialog').classList.add('hidden');
    confirmCallback = null;
}

// ─── Status Bar ──────────────────────────────────────────────────────────────

/**
 * Updates the application status bar in the header.
 * @param {string} text - Status text to display
 * @param {'idle'|'busy'|'success'|'error'} type - Status type
 */
function setStatus(text, type = 'idle') {
    const indicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');

    // Remove all status classes
    indicator.className = 'status-indicator';
    statusText.className = '';

    // Apply the appropriate class
    const classMap = {
        'idle': '',
        'busy': 'busy',
        'success': 'success',
        'error': 'error'
    };

    if (classMap[type]) {
        indicator.classList.add(classMap[type]);
    }

    statusText.textContent = text;
}

// ─── Log Console ─────────────────────────────────────────────────────────────

let logPollInterval = null;

/**
 * Fetches recent log entries from the main process and displays them.
 */
async function refreshLogConsole() {
    try {
        const logs = await window.api.getLogs(200);
        const logContent = document.getElementById('log-content');
        logContent.innerHTML = logs.map(entry => {
            const cssClass = getLogClass(entry);
            return `<div class="log-entry ${cssClass}">${escapeHtml(entry)}</div>`;
        }).join('');
        logContent.scrollTop = logContent.scrollHeight;
    } catch (err) {
        console.error('Failed to refresh logs:', err);
    }
}

/**
 * Determines the CSS class for a log entry based on its level.
 */
function getLogClass(entry) {
    if (entry.includes('[ERROR]')) return 'log-error';
    if (entry.includes('[WARN]')) return 'log-warn';
    if (entry.includes('[SUCCESS]')) return 'log-success';
    return 'log-info';
}

/**
 * Copies selected text from the log console, or all log entries if nothing is selected.
 */
async function copyLogs() {
    try {
        // Check if there's a text selection in the log console
        const selection = window.getSelection();
        const selectedText = selection ? selection.toString().trim() : '';

        if (selectedText) {
            // Copy only the selected text
            await window.api.writeToClipboard(selectedText);
            showToast('Selected text copied to clipboard.', 'success');
            return;
        }

        // No selection - copy all logs
        const logs = await window.api.getLogs(200);
        
        if (logs.length === 0) {
            showToast('Nothing to copy.', 'info');
            return;
        }
        
        const logText = logs.join('\n');
        
        await window.api.writeToClipboard(logText);
        showToast('Log copied to clipboard.', 'success');
    } catch (err) {
        console.error('Failed to copy logs:', err);
        showToast('Failed to copy logs', 'error');
    }
}

/**
 * Clears all log entries.
 */
async function clearLogs() {
    try {
        await window.api.clearLogs();
        document.getElementById('log-content').innerHTML = '';
        showToast('Logs cleared', 'info');
    } catch (err) {
        console.error('Failed to clear logs:', err);
    }
}

/**
 * Copies the selected text from the log console to the clipboard.
 * Used by the right-click context menu.
 */
async function copySelectedLogs() {
    try {
        const selection = window.getSelection();
        const selectedText = selection ? selection.toString().trim() : '';

        if (!selectedText) {
            showToast('No text selected.', 'info');
            return;
        }

        await window.api.writeToClipboard(selectedText);
        showToast('Selected text copied to clipboard.', 'success');
    } catch (err) {
        console.error('Failed to copy selected text:', err);
        showToast('Failed to copy selected text', 'error');
    }
}

/**
 * Starts polling the log console at a regular interval.
 */
function startLogPolling() {
    if (logPollInterval) return;
    refreshLogConsole();
    logPollInterval = setInterval(refreshLogConsole, 3000);
}

/**
 * Stops polling the log console.
 */
function stopLogPolling() {
    if (logPollInterval) {
        clearInterval(logPollInterval);
        logPollInterval = null;
    }
}

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Escapes HTML special characters to prevent XSS.
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Formats a date string into a human-readable format.
 * @param {string} dateStr - ISO date string
 * @returns {string} Formatted date
 */
function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleString();
}

/**
 * Truncates a commit hash to a shorter length.
 * @param {string} hash - Full commit hash
 * @param {number} len - Length to truncate to
 * @returns {string} Truncated hash
 */
function truncateHash(hash, len = 7) {
    if (!hash) return '';
    return hash.substring(0, len);
}

/**
 * Creates a table row element from a data object.
 * @param {Object} data - The data for the row
 * @param {Array} columns - Column definitions [{ key, label, render }]
 * @returns {string} HTML string for the row
 */
function createTableRow(data, columns) {
    const cells = columns.map(col => {
        let value = data[col.key];
        if (col.render) {
            value = col.render(value, data);
        } else {
            value = escapeHtml(String(value || ''));
        }
        return `<td>${value}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
}

/**
 * Shows an empty state message in a container.
 * @param {HTMLElement} container - The container element
 * @param {string} icon - Emoji or icon to display
 * @param {string} text - The empty state message
 */
function showEmptyState(container, icon, text) {
    container.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon">${icon}</div>
            <div class="empty-state-text">${escapeHtml(text)}</div>
        </div>
    `;
}

/**
 * Shows a loading state in a container.
 * @param {HTMLElement} container - The container element
 */
function showLoadingState(container) {
    container.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon">&#x23F3;</div>
            <div class="empty-state-text">Loading...</div>
        </div>
    `;
}

// ─── Initialize Log Console ──────────────────────────────────────────────────

/**
 * Binds the buttons that live permanently in the application shell
 * (index.html) rather than inside a loaded page.
 *
 * These cannot use inline onclick="..." attributes because index.html sets a
 * strict Content-Security-Policy that blocks them, so they are wired up here.
 */
function initShellButtons() {
    const openLogsBtn = document.getElementById('open-logs-btn');
    if (openLogsBtn) {
        openLogsBtn.addEventListener('click', () => window.api.openPath('Logs'));
    }

    const openReposBtn = document.getElementById('open-repos-btn');
    if (openReposBtn) {
        openReposBtn.addEventListener('click', () => window.api.openPath('GitHubPromotion'));
    }

    const copyBtn = document.getElementById('copy-logs-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', copyLogs);
    }

    const clearBtn = document.getElementById('clear-logs-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', clearLogs);
    }

    // "Cancel" simply dismisses the confirmation dialog without running the
    // callback that was registered when the dialog was opened.
    const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
    if (confirmCancelBtn) {
        confirmCancelBtn.addEventListener('click', closeConfirmDialog);
    }
}

// Add right-click context menu to the log console for copy operations
document.addEventListener('DOMContentLoaded', () => {
    initShellButtons();
    startLogPolling();

    const logConsole = document.getElementById('log-console');
    if (logConsole) {
        logConsole.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            copySelectedLogs();
        });
    }
});
