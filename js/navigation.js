/**
 * Handles navigation between pages and dynamic content loading.
 * Uses a single-window architecture with a left navigation panel
 * that loads page content into the main content area.
 *
 * Each page consists of an HTML file in pages/ and a JS file in js/.
 * The JS file for each page must expose an init() function.
 */

// ─── Page Registry ───────────────────────────────────────────────────────────

const PAGES = {
    repositories: {
        title: 'Repositories',
        html: 'pages/repositories.html',
        js: 'js/repositories.js'
    },
    dashboard: {
        title: 'Dashboard',
        html: 'pages/dashboard.html',
        js: 'js/dashboard.js'
    },
    promote: {
        title: 'Promote',
        html: 'pages/promote.html',
        js: 'js/promote.js'
    },
    revert: {
        title: 'Revert',
        html: 'pages/revert.html',
        js: 'js/revert.js'
    },
    compare: {
        title: 'Compare',
        html: 'pages/compare.html',
        js: 'js/compare.js'
    },
    history: {
        title: 'History',
        html: 'pages/history.html',
        js: 'js/history.js'
    },
    settings: {
        title: 'Settings',
        html: 'pages/settings.html',
        js: 'js/settings.js'
    }
};

// ─── State ───────────────────────────────────────────────────────────────────

let currentPage = null;
let loadedScripts = new Set();

// ─── Navigation ──────────────────────────────────────────────────────────────

/**
 * Initializes navigation by attaching click handlers to nav items.
 */
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page;
            if (page && page !== currentPage) {
                navigateTo(page);
            }
        });
    });
}

/**
 * Navigates to the specified page by loading its HTML and JS.
 * @param {string} pageName - The page key from the PAGES registry
 */
async function navigateTo(pageName) {
    const page = PAGES[pageName];
    if (!page) {
        console.error(`Unknown page: ${pageName}`);
        return;
    }

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === pageName);
    });

    // Update page title
    document.getElementById('page-title').textContent = page.title;

    // Clear content actions
    document.getElementById('content-actions').innerHTML = '';

    currentPage = pageName;

    try {
        // Load the HTML content
        const response = await fetch(page.html);
        if (!response.ok) {
            throw new Error(`Failed to load ${page.html}: ${response.status}`);
        }
        const html = await response.text();
        document.getElementById('content-body').innerHTML = html;

        // Reset the current page initializer and load the page-specific JS
        window.pageInit = null;
        await loadPageScript(page.js);

        if (typeof window.pageInit !== 'function') {
            throw new Error(`Page script ${page.js} did not register pageInit — check DevTools console for a script error (e.g. duplicate declaration).`);
        }

        // Initialize the page
        window.pageInit();
    } catch (err) {
        console.error('Failed to load page:', err);
        document.getElementById('content-body').innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">&#x26A0;</div>
                <div class="empty-state-text">Failed to load page</div>
                <p class="text-muted">${escapeHtml(err.message)}</p>
            </div>
        `;
    }
}

/**
 * Dynamically loads a JavaScript file and waits for it to execute.
 * Avoids re-loading already loaded scripts.
 * @param {string} src - Path to the JS file
 * @returns {Promise<void>}
 */
function loadPageScript(src) {
    return new Promise((resolve, reject) => {
        // Remove previous page script if it exists
        const existing = document.querySelector(`script[data-page-script="${src}"]`);
        if (existing) {
            // Script already loaded, just resolve
            resolve();
            return;
        }

        // Remove any previously loaded page scripts
        document.querySelectorAll('script[data-page-script]').forEach(s => s.remove());

        const script = document.createElement('script');
        script.src = src;
        script.dataset.pageScript = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.body.appendChild(script);
    });
}

// ─── Initialize ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    initNavigation();

    // Load the default page (Repositories)
    navigateTo('repositories');
});