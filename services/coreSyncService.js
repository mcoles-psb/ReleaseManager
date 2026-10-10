const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const simpleGit = require('simple-git');

/**
 * Syncs the latest core into project working folders.
 *
 * Unlike the rest of Release Manager, this does NOT work on the bare mirrors
 * in GitHubPromotion. A core sync needs a working tree (merge, core-owned
 * file replacement, npm install), so it runs core's own script,
 * scripts/sync-repo.ps1, against each project's normal working folder.
 *
 * The projects are the user's own list (Config/coreSyncProjects.json), added
 * and removed on the Sync Core page. They are independent of the Repositories
 * page: a project only has to be a Git working folder.
 *
 * The sync rules live in one place (the script). This service only keeps the
 * list, reports each folder's state, and streams the script's output into
 * the application log.
 */
class CoreSyncService {
    constructor(appRoot, settingsService, logger) {
        this.appRoot = appRoot;
        this.settingsService = settingsService;
        this.logger = logger;
        // Absolute, machine-specific paths: this file is git-ignored.
        this.projectsFile = path.join(appRoot, 'Config', 'coreSyncProjects.json');
        // The script changes branches and pushes, so a folder may only have one
        // sync at a time. Different projects can sync at the same time.
        this.runningFolders = new Set();
    }

    /**
    * Folder where core's own working copy is looked for (and where the list
    * is first seeded from). Defaults to the folder that contains Release Manager.
     */
    getWorkingDirectory() {
        const configured = String(this.settingsService.get('workingDirectory') || '').trim();
        return configured ? path.resolve(configured) : path.resolve(this.appRoot, '..');
    }

    getCoreRepoName() {
        return String(this.settingsService.get('coreRepoName') || '').trim() || 'PSBUniverse-core';
    }

    /**
     * Prefers core's copy of the script (always the newest rules) and falls
     * back to the module's own copy when core is not checked out locally.
     */
    resolveSyncScript(projectDir) {
        const coreScript = path.join(this.getWorkingDirectory(), this.getCoreRepoName(), 'scripts', 'sync-repo.ps1');
        if (fs.existsSync(coreScript)) return coreScript;
        const ownScript = path.join(projectDir, 'scripts', 'sync-repo.ps1');
        return fs.existsSync(ownScript) ? ownScript : null;
    }

    // ── Project list ────────────────────────────────────────────────────────

    isGitWorkingFolder(folder) {
        return fs.existsSync(path.join(folder, '.git'));
    }

    // Windows paths are case-insensitive.
    samePath(a, b) {
        return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    }

    /**
     * Returns the saved projects: [{ name, folder }].
     *
     * The first time (no file yet) the list is seeded from the registered
     * repositories whose working folder exists, so projects that were shown
     * before this list existed are carried over. After that the file is the
     * only source and the Repositories page no longer affects it.
     */
    loadProjects(seedRepositories = []) {
        if (fs.existsSync(this.projectsFile)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(this.projectsFile, 'utf-8'));
                return (Array.isArray(parsed) ? parsed : [])
                    .filter(p => p && p.name && p.folder)
                    .map(p => ({ name: String(p.name), folder: String(p.folder) }));
            } catch (err) {
                this.logger.error(`Core Sync: could not read ${this.projectsFile}: ${err.message}`);
                return [];
            }
        }

        const coreRepoName = this.getCoreRepoName();
        const seeded = (seedRepositories || [])
            .filter(r => r && r.name && r.name !== coreRepoName && r.enabled !== false)
            .map(r => ({ name: r.name, folder: path.join(this.getWorkingDirectory(), r.name) }))
            .filter(p => this.isGitWorkingFolder(p.folder));
        this.saveProjects(seeded);
        return seeded;
    }

    saveProjects(projects) {
        fs.writeFileSync(this.projectsFile, JSON.stringify(projects, null, 4), 'utf-8');
    }

    /**
     * Adds a working folder to the list. The project is named after the folder.
     * Throws an Error with a user-facing message when it cannot be added.
     */
    addProject(folderPath, seedRepositories = []) {
        const raw = String(folderPath || '').trim();
        if (!raw) throw new Error('No folder selected.');

        const folder = path.resolve(raw);
        if (!fs.existsSync(folder)) throw new Error('Folder not found.');
        if (!this.isGitWorkingFolder(folder)) {
            throw new Error('That folder is not a Git working folder (it has no .git inside).');
        }

        const name = path.basename(folder);
        if (name === this.getCoreRepoName()) throw new Error('Core cannot be synced into itself.');

        const projects = this.loadProjects(seedRepositories);
        if (projects.some(p => this.samePath(p.folder, folder))) {
            throw new Error(`${name} is already in the list.`);
        }
        if (projects.some(p => p.name.toLowerCase() === name.toLowerCase())) {
            throw new Error(`A project named ${name} is already in the list.`);
        }

        const project = { name, folder };
        this.saveProjects([...projects, project]);
        this.logger.info(`Core Sync: added project ${name} (${folder})`);
        return project;
    }

    /**
     * Removes a project from the list only. Its folder and files are untouched.
     */
    removeProject(name, seedRepositories = []) {
        const projects = this.loadProjects(seedRepositories);
        this.saveProjects(projects.filter(p => p.name !== name));
        this.logger.info(`Core Sync: removed project ${name} from the list`);
    }

    // ── Status ──────────────────────────────────────────────────────────────

    /**
     * Latest commit of core's main branch, read through the project's own
     * `core` remote (the same remote the sync script fetches from).
     * `cache` maps remote URL -> promise, so projects sharing one core
     * address cost a single network call per status check.
     * Returns { hasCore, head }.
     */
    async getCoreHead(git, cache) {
        let url = '';
        try {
            url = (await git.raw(['remote', 'get-url', 'core'])).trim();
        } catch (err) {
            return { hasCore: false, head: null };
        }
        if (!url) return { hasCore: false, head: null };

        if (!cache.has(url)) {
            cache.set(url, git.raw(['ls-remote', 'core', 'refs/heads/main'])
                .then((output) => {
                    const hash = String(output || '').trim().split(/\s+/)[0];
                    return /^[0-9a-f]{40}$/i.test(hash) ? hash : null;
                })
                .catch((err) => {
                    this.logger.warn(`Core Sync: could not read core's latest commit: ${err.message}`);
                    return null;
                }));
        }
        return { hasCore: true, head: await cache.get(url) };
    }

    /**
     * Describes one project's working folder: whether it exists, its branch,
     * uncommitted files, and whether it already contains core's latest commit.
     */
    async getProjectStatus(project, cache) {
        const folder = project.folder;
        const status = {
            name: project.name,
            folder,
            folderExists: false,
            hasScript: false,
            branch: '',
            localChanges: 0,
            coreState: 'unknown', // 'current' | 'behind' | 'unknown' | 'none' (no core remote)
            coreHead: null,
            canSync: false,
            note: ''
        };

        if (!this.isGitWorkingFolder(folder)) {
            status.note = 'Working folder not found';
            return status;
        }
        status.folderExists = true;
        status.hasScript = Boolean(this.resolveSyncScript(folder));

        try {
            const git = simpleGit(folder);
            status.branch = (await git.raw(['branch', '--show-current'])).trim();
            const porcelain = await git.raw(['status', '--porcelain']);
            status.localChanges = porcelain.split('\n').filter(line => line.trim()).length;

            const core = await this.getCoreHead(git, cache);
            if (!core.hasCore) {
                status.coreState = 'none';
            } else if (core.head) {
                status.coreHead = core.head;
                try {
                    // Commits in core that this project does not have yet. Git
                    // fails here when the project has never fetched that commit,
                    // which also means it is behind.
                    const missing = await git.raw(['rev-list', '--count', `HEAD..${core.head}`]);
                    status.coreState = Number(String(missing).trim()) === 0 ? 'current' : 'behind';
                } catch (err) {
                    status.coreState = 'behind';
                }
            }
        } catch (err) {
            status.note = err.message;
            return status;
        }

        if (!status.hasScript) {
            status.note = 'sync-repo.ps1 not found';
        } else if (status.branch !== 'main') {
            status.note = `On branch "${status.branch || 'detached'}" - sync needs main`;
        }
        status.canSync = status.hasScript && status.branch === 'main';
        return status;
    }

    /**
     * Status of every project in the list.
     */
    async getStatus(seedRepositories = []) {
        const projects = this.loadProjects(seedRepositories);
        const cache = new Map();
        const statuses = await Promise.all(projects.map(project => this.getProjectStatus(project, cache)));
        const withHead = statuses.find(s => s.coreHead);
        return {
            coreHead: withHead ? withHead.coreHead : null,
            projects: statuses
        };
    }

    // ── Sync ────────────────────────────────────────────────────────────────

    /**
     * Runs the core sync script for one project in the list and resolves with
     * the result. Never rejects. Every output line is written to the
     * application log, prefixed with the project name, so the Log Console
     * shows live progress. Only listed projects can be synced; the caller
     * never supplies a path.
     */
    syncProject(projectName, seedRepositories = []) {
        return new Promise((resolve) => {
            const name = String(projectName || '');
            const fail = (message) => {
                this.logger.error(`Core Sync: ${name} - ${message}`);
                resolve({ name, success: false, exitCode: null, message });
            };

            if (process.platform !== 'win32') {
                fail('Core sync runs a PowerShell script and is only supported on Windows.');
                return;
            }
            const project = this.loadProjects(seedRepositories).find(p => p.name === name);
            if (!project) {
                fail('Project is not in the Sync Core list.');
                return;
            }
            const folder = project.folder;
            // Windows paths are case-insensitive.
            const folderKey = path.resolve(folder).toLowerCase();
            if (this.runningFolders.has(folderKey)) {
                fail('A core sync is already running for this project.');
                return;
            }
            if (!this.isGitWorkingFolder(folder)) {
                fail(`Working folder not found: ${folder}`);
                return;
            }
            const script = this.resolveSyncScript(folder);
            if (!script) {
                fail('sync-repo.ps1 not found in core or in the project.');
                return;
            }

            this.runningFolders.add(folderKey);
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                this.runningFolders.delete(folderKey);
                resolve(result);
            };

            const scriptArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-RepoPath', folder];

            // Git writes normal progress to stderr, so both streams are logged
            // as info; success or failure is decided by the exit code alone.
            const pipeToLog = (stream) => {
                let buffer = '';
                stream.setEncoding('utf8');
                stream.on('data', (chunk) => {
                    buffer += chunk;
                    const lines = buffer.split(/\r?\n/);
                    buffer = lines.pop();
                    lines.filter(line => line.trim()).forEach(line => this.logger.info(`[${name}] ${line.trimEnd()}`));
                });
                stream.on('end', () => {
                    if (buffer.trim()) this.logger.info(`[${name}] ${buffer.trimEnd()}`);
                });
            };
            // sync-repo.ps1 is written for PowerShell 7 (pwsh). Windows
            // PowerShell 5.1 is used only when pwsh cannot be started.
            const start = (executable) => {
                // Set when this attempt is given up in favour of the fallback, so
                // its late 'close' event cannot report a result for the sync.
                let abandoned = false;

                this.logger.info(`Core Sync: starting ${name} with ${executable} using ${script}`);
                const child = spawn(executable, scriptArgs, { cwd: folder, windowsHide: true });
                pipeToLog(child.stdout);
                pipeToLog(child.stderr);

                child.on('error', (err) => {
                    if (executable === 'pwsh.exe') {
                        abandoned = true;
                        this.logger.warn(`Core Sync: PowerShell 7 could not be started (${err.message}); using Windows PowerShell instead`);
                        start('powershell.exe');
                        return;
                    }
                    this.logger.error(`Core Sync: ${name} could not start - ${err.message}`);
                    finish({ name, success: false, exitCode: null, message: err.message });
                });

                child.on('close', (code) => {
                    if (abandoned) return;
                    if (code === 0) {
                        this.logger.success(`Core Sync: ${name} synced`);
                        finish({ name, success: true, exitCode: 0, message: 'Synced' });
                    } else {
                        this.logger.error(`Core Sync: ${name} failed (exit ${code}) - see the lines above`);
                        finish({ name, success: false, exitCode: code, message: `Sync failed (exit ${code}). See the Log Console.` });
                    }
                });
            };

            start('pwsh.exe');
        });
    }
}

module.exports = CoreSyncService;