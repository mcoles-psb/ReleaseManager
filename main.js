const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Services
const SettingsService = require('./services/settingsService');
const Logger = require('./services/logger');
const GitService = require('./services/gitService');
const RepositoryService = require('./services/repositoryService');
const TagService = require('./services/tagService');

let mainWindow = null;
let settingsService = null;
let logger = null;
let gitService = null;
let repositoryService = null;
let tagService = null;

/**
 * Creates the main application window with a fixed size
 * and loads the index.html shell.
 */
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: 'PSBUniverse Release Manager',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile('index.html');

    // Open DevTools in development
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

/**
 * Initializes all services and registers IPC handlers.
 * Ensures required directories exist before starting.
 */
function initializeServices() {
    // Ensure required directories exist
    const dirs = ['Config', 'GitHubPromotion', 'Logs', 'Reports'];
    dirs.forEach(dir => {
        const dirPath = path.join(__dirname, dir);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    });

    settingsService = new SettingsService(path.join(__dirname, 'Config'));
    logger = new Logger(path.join(__dirname, 'Logs'));
    gitService = new GitService(path.join(__dirname, 'GitHubPromotion'), logger);
    repositoryService = new RepositoryService(gitService, logger);
    tagService = new TagService(gitService, logger);
}

/**
 * Returns the list of mirror repositories found in the GitHubPromotion directory.
 * Each repository is a bare Git mirror.
 */
function getRepositories() {
    const reposDir = path.join(__dirname, 'GitHubPromotion');
    if (!fs.existsSync(reposDir)) {
        return [];
    }
    return fs.readdirSync(reposDir).filter(name => name.endsWith('.git'));
}

/**
 * Derives the PROD repository URL from a DEV repository URL.
 * Replaces the DEV organization with the PROD organization.
 * @param {string} devUrl - The DEV repository URL
 * @returns {string} The derived PROD repository URL
 */
function deriveProdUrl(devUrl) {
    if (!devUrl) return '';
    // HTTPS format: https://github.com/PSBUniverse-DEV/repo.git
    if (devUrl.includes('https://github.com/')) {
        return devUrl.replace('PSBUniverse-DEV', 'PSBUniverse-PROD');
    }
    return devUrl;
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

function registerIpcHandlers() {
    // ── Repository Operations ────────────────────────────────────────────────

    /**
     * Returns the list of configured repositories from the configuration file.
     */
    ipcMain.handle('repositories:list', async () => {
        console.log('[main] repositories:list received');
        const repos = repositoryService.loadRepositories();
        console.log('[main] repositories:list returned', repos.length, 'repositories');
        return repos;
    });

    /**
     * Clones a new mirror repository and configures DEV and PROD remotes.
     * Expects: { repoName, devRepoUrl, prodRepoUrl }
     */
    ipcMain.handle('repositories:add', async (event, { repoName, devRepoUrl, prodRepoUrl }) => {
        console.log('[main] repositories:add received:', { repoName, devRepoUrl, prodRepoUrl });
        const result = await repositoryService.cloneRepository(devRepoUrl, prodRepoUrl, repoName);
        
        // Save to configuration (avoid duplicates)
        const repos = repositoryService.loadRepositories();
        const existing = repos.find(r => r.name === repoName);
        if (existing) {
            // Update existing entry
            Object.assign(existing, result.repository);
        } else {
            repos.push(result.repository);
        }
        repositoryService.saveRepositories(repos);
        
        logger.info(`Repository added: ${repoName}`);
        console.log('[main] repositories:add completed, saved to config');
        return result;
    });

    /**
     * Removes a mirror repository from disk and configuration.
     * Expects: { repoName } (without .git extension)
     */
    ipcMain.handle('repositories:remove', async (event, { repoName }) => {
        console.log('[main] repositories:remove received:', repoName);
        // Normalize: strip .git if present
        const cleanName = repoName.replace(/\.git$/, '');
        console.log('[main] removing with clean name:', cleanName);
        await repositoryService.deleteRepository(cleanName);
        
        // Remove from configuration
        const repos = repositoryService.loadRepositories();
        const filtered = repos.filter(r => r.name !== cleanName);
        repositoryService.saveRepositories(filtered);
        
        logger.info(`Repository removed: ${cleanName}`);
        console.log('[main] repositories:remove completed');
        return { success: true };
    });

    /**
     * Verifies a repository's remote configuration.
     * Expects: { repoName }
     */
    ipcMain.handle('repositories:verify', async (event, { repoName }) => {
        console.log('[main] repositories:verify received:', repoName);
        const result = await repositoryService.verifyRepository(repoName);
        console.log('[main] repositories:verify result:', result);
        return result;
    });

    /**
     * Refreshes a repository by fetching from origin.
     * Expects: { repoName }
     */
    ipcMain.handle('repositories:refresh', async (event, { repoName }) => {
        console.log('[main] repositories:refresh received:', repoName);
        const result = await repositoryService.refreshRepository(repoName);
        console.log('[main] repositories:refresh result:', result);
        return result;
    });

    /**
     * Scans the GitHubPromotion directory for existing mirror repositories
     * and registers any that aren't in the configuration.
     */
    ipcMain.handle('repositories:scan', async () => {
        const mirrors = getRepositories();
        const repos = repositoryService.loadRepositories();
        const registered = new Set(repos.map(r => r.name));
        const added = [];

        for (const mirror of mirrors) {
            const name = mirror.replace('.git', '');
            if (registered.has(name)) continue;

            const repoPath = path.join(__dirname, 'GitHubPromotion', mirror);
            try {
                const remotes = await gitService.getRemotes(repoPath);
                const devRepo = remotes.origin || '';
                // Derive PROD URL from DEV URL if prod remote doesn't exist
                let prodRepo = remotes.prod || '';
                if (!prodRepo && devRepo) {
                    prodRepo = deriveProdUrl(devRepo);
                }

                repos.push({
                    name: name,
                    path: `GitHubPromotion/${mirror}`,
                    devRepo: devRepo,
                    prodRepo: prodRepo,
                    defaultBranch: 'main',
                    enabled: true,
                    status: 'ready'
                });
                added.push(name);
                logger.info(`Registered existing mirror: ${name} (DEV: ${devRepo}, PROD: ${prodRepo})`);
            } catch (err) {
                logger.error(`Failed to scan mirror ${name}: ${err.message}`);
            }
        }

        if (added.length > 0) {
            repositoryService.saveRepositories(repos);
        }

        return { added, total: repos.length };
    });

    // ── Branch Operations ───────────────────────────────────────────────────

    /**
     * Returns the branches available in a repository.
     * Expects: { repoName }
     */
    ipcMain.handle('branches:list', async (event, { repoName }) => {
        console.log('[main] branches:list received:', repoName);
        const cleanName = repoName.replace(/\.git$/, '');
        const repoPath = path.join(__dirname, 'GitHubPromotion', `${cleanName}.git`);
        const branches = await gitService.listBranches(repoPath);
        console.log('[main] branches:list returned:', branches);
        return branches;
    });

    // ── Promote Operations ──────────────────────────────────────────────────

    /**
     * Promotes a branch from DEV (origin) to PROD (prod).
     * Expects: { repoName, branch }
     * Process: git fetch origin, git push prod <branch>
     */
    ipcMain.handle('promote:branch', async (event, { repoName, branch }) => {
        const repoPath = path.join(__dirname, 'GitHubPromotion', `${repoName.replace(/\.git$/, '')}.git`);
        await repositoryService.promoteBranch(repoPath, branch);
        logger.info(`Promoted ${repoName} branch ${branch} to PROD`);
        return { success: true };
    });

    /**
     * Promotes multiple branches from DEV to PROD.
     * Expects: { repoName, branches }
     */
    ipcMain.handle('promote:branches', async (event, { repoName, branches }) => {
        const repoPath = path.join(__dirname, 'GitHubPromotion', `${repoName.replace(/\.git$/, '')}.git`);
        for (const branch of branches) {
            await repositoryService.promoteBranch(repoPath, branch);
            logger.info(`Promoted ${repoName} branch ${branch} to PROD`);
        }
        return { success: true, promoted: branches.length };
    });

    // ── Revert Operations ───────────────────────────────────────────────────

    /**
     * Reverts a specific commit on the PROD branch.
     * Uses git revert (safe, does not rewrite history).
     * Expects: { repoName, branch, commitHash }
     */
    ipcMain.handle('revert:commit', async (event, { repoName, branch, commitHash }) => {
        const repoPath = path.join(__dirname, 'GitHubPromotion', `${repoName.replace(/\.git$/, '')}.git`);
        await repositoryService.revertCommit(repoPath, branch, commitHash);
        logger.info(`Reverted ${repoName} commit ${commitHash} on ${branch}`);
        return { success: true };
    });

    // ── History Operations ──────────────────────────────────────────────────

    /**
     * Returns the commit history for a branch.
     * Expects: { repoName, branch, maxCount }
     */
    ipcMain.handle('history:get', async (event, { repoName, branch, maxCount = 50 }) => {
        const repoPath = path.join(__dirname, 'GitHubPromotion', `${repoName.replace(/\.git$/, '')}.git`);
        return await repositoryService.getHistory(repoPath, branch, maxCount);
    });

    ipcMain.handle('history:getDev', async (event, { repoName, branch, maxCount = 50 }) => {
        const repoPath = path.join(__dirname, 'GitHubPromotion', `${repoName.replace(/\.git$/, '')}.git`);
        return await repositoryService.getDevHistory(repoPath, branch, maxCount);
    });

    // ── Compare Operations ──────────────────────────────────────────────────

    /**
     * Compares DEV (origin) against PROD (prod) for a given branch.
     * Fetches both origin and prod first to ensure up-to-date comparison.
     * Returns detailed comparison data including latest commits from both sides.
     * Expects: { repoName, branch }
     */
    ipcMain.handle('compare:get', async (event, { repoName, branch }) => {
        console.log('[main] compare:get received:', { repoName, branch });
        const cleanName = repoName.replace(/\.git$/, '');
        const repoPath = path.join(__dirname, 'GitHubPromotion', `${cleanName}.git`);
        
        // Fetch both remotes first to ensure fresh comparison
        await gitService.fetchOrigin(repoPath);
        try {
            await gitService.fetchProd(repoPath);
        } catch (err) {
            console.log('[main] prod fetch skipped for compare:', err.message);
        }
        
        const result = await repositoryService.compareBranches(repoPath, branch);
        console.log('[main] compare:get returned', result.commitCount, 'commits');
        return result;
    });

    // ── Tag Operations ──────────────────────────────────────────────────────

    /**
     * Lists all tags in a repository.
     * Expects: { repoName }
     */
    ipcMain.handle('tags:list', async (event, { repoName }) => {
        const repoPath = path.join(__dirname, 'GitHubPromotion', `${repoName.replace(/\.git$/, '')}.git`);
        return await tagService.listTags(repoPath);
    });

    /**
     * Creates a new tag and pushes it to PROD.
     * Expects: { repoName, tagName, commitHash }
     */
    ipcMain.handle('tags:create', async (event, { repoName, tagName, commitHash }) => {
        const repoPath = path.join(__dirname, 'GitHubPromotion', `${repoName.replace(/\.git$/, '')}.git`);
        await tagService.createTag(repoPath, tagName, commitHash);
        logger.info(`Tag created and pushed: ${repoName} ${tagName}`);
        return { success: true };
    });

    /**
     * Pushes an existing tag to PROD.
     * Expects: { repoName, tagName }
     */
    ipcMain.handle('tags:push', async (event, { repoName, tagName }) => {
        const repoPath = path.join(__dirname, 'GitHubPromotion', `${repoName.replace(/\.git$/, '')}.git`);
        await tagService.pushTag(repoPath, tagName);
        logger.info(`Tag pushed to PROD: ${repoName} ${tagName}`);
        return { success: true };
    });

    // ── Settings Operations ─────────────────────────────────────────────────

    /**
     * Returns the current application settings.
     */
    ipcMain.handle('settings:get', async () => {
        return settingsService.getAll();
    });

    /**
     * Saves the provided settings.
     * Expects: { settings }
     */
    ipcMain.handle('settings:save', async (event, { settings }) => {
        settingsService.save(settings);
        logger.info('Settings updated');
        return { success: true };
    });

    // ── Log Operations ──────────────────────────────────────────────────────

    /**
     * Returns the log entries.
     * Expects: { maxLines }
     */
    ipcMain.handle('logs:get', async (event, { maxLines = 200 }) => {
        return logger.getRecent(maxLines);
    });

    /**
     * Clears all log entries.
     */
    ipcMain.handle('logs:clear', async () => {
        logger.clear();
        return { success: true };
    });

    // ── App Operations ──────────────────────────────────────────────────────

    /**
     * Opens a file or directory in the system file explorer.
     * Expects: { target } (path to open)
     */
    ipcMain.handle('app:openPath', async (event, { target }) => {
        const fullPath = path.resolve(__dirname, target);
        if (fs.existsSync(fullPath)) {
            const { shell } = require('electron');
            shell.openPath(fullPath);
        }
        return { success: true };
    });

    /**
     * Shows a confirmation dialog.
     * Expects: { title, message, detail }
     */
    ipcMain.handle('dialog:confirm', async (event, { title, message, detail }) => {
        const result = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            buttons: ['Cancel', 'Confirm'],
            defaultId: 0,
            cancelId: 0,
            title: title,
            message: message,
            detail: detail
        });
        return result.response === 1;
    });

    /**
     * Writes text to the system clipboard.
     * Expects: { text }
     */
    ipcMain.handle('clipboard:writeText', async (event, { text }) => {
        const { clipboard } = require('electron');
        clipboard.writeText(text);
        return { success: true };
    });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
    initializeServices();
    registerIpcHandlers();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});