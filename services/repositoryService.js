/**
 * Provides high-level repository operations for managing Git bare mirror repositories.
 *
 * This service handles:
 * - Loading and saving repository configuration
 * - Cloning new repositories as bare mirrors
 * - Deleting repositories
 * - Refetching repositories (cloning them first if the mirror is missing)
 *
 * All Git operations are delegated to GitService.
 */
const fs = require('fs');
const path = require('path');

class RepositoryService {
    /**
     * Creates a new RepositoryService instance.
     * @param {GitService} gitService - The Git service for Git operations
     * @param {Logger} logger - The logger for logging operations
     */
    constructor(gitService, logger) {
        this.git = gitService;
        this.logger = logger;
        this.configPath = path.join(__dirname, '..', 'Config', 'repositories.json');
    }

    /**
     * Loads all repositories from the configuration file.
     * @returns {Array} Array of repository objects
     */
    loadRepositories() {
        try {
            if (!fs.existsSync(this.configPath)) {
                return [];
            }
            const data = fs.readFileSync(this.configPath, 'utf-8');
            return JSON.parse(data);
        } catch (err) {
            this.logger.error(`Failed to load repositories: ${err.message}`);
            return [];
        }
    }

    /**
     * Saves repositories to the configuration file.
     * @param {Array} repositories - Array of repository objects to save
     */
    saveRepositories(repositories) {
        try {
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.configPath, JSON.stringify(repositories, null, 2), 'utf-8');
            this.logger.info(`Saved ${repositories.length} repositories to configuration`);
        } catch (err) {
            this.logger.error(`Failed to save repositories: ${err.message}`);
            throw new Error(`Failed to save repositories: ${err.message}`);
        }
    }

    /**
     * Clones a new repository as a bare mirror and configures the PROD remote.
     * @param {string} devRepoUrl - The DEV repository URL
     * @param {string} prodRepoUrl - The PROD repository URL
     * @param {string} repoName - The repository name (e.g., "PSBUniverse-core")
     * @returns {Object} Result object with success status and repository info
     */
    async cloneRepository(devRepoUrl, prodRepoUrl, repoName) {
        try {
            const repoPath = path.join(this.git.baseDir, `${repoName}.git`);
            const repoExists = fs.existsSync(repoPath);

            if (repoExists) {
                this.logger.info(`Repository ${repoName} already exists on disk. Registering existing mirror...`);
            } else {
                this.logger.info(`Cloning repository: ${repoName}`);
                // Clone as bare mirror from DEV
                await this.git.cloneMirror(devRepoUrl, repoPath);
            }

            // Add PROD remote if it doesn't exist
            const remotes = await this.git.getRemotes(repoPath);
            if (!remotes.prod) {
                await this.git.addRemote(repoPath, 'prod', prodRepoUrl);
            } else {
                this.logger.info(`PROD remote already exists: ${remotes.prod}`);
            }

            // Verify remotes
            const finalRemotes = await this.git.getRemotes(repoPath);
            this.logger.info(`Repository ${repoName} configured with remotes: ${JSON.stringify(finalRemotes)}`);

            // Fetch both remotes immediately so the repo is fully
            // queryable right away — refs/remotes/prod/<branch> must
            // exist locally before any history/compare/promote
            // operation can reference it.
            this.logger.info(`Fetching remotes for newly added repository: ${repoName}`);
            await this.git.fetchOrigin(repoPath);
            try {
                await this.git.fetchProd(repoPath);
            } catch (err) {
                // PROD repo may legitimately be empty/new — don't fail
                // the whole add-repository flow over this, but log it
                // clearly so it's visible in the log console.
                this.logger.warn(`Could not fetch prod for ${repoName} (may be a new/empty PROD repo): ${err.message}`);
            }

            return {
                success: true,
                repository: {
                    name: repoName,
                    path: `GitHubPromotion/${repoName}.git`,
                    devRepo: devRepoUrl,
                    prodRepo: prodRepoUrl,
                    defaultBranch: 'main',
                    enabled: true,
                    status: 'ready'
                }
            };
        } catch (err) {
            this.logger.error(`Failed to clone repository ${repoName}: ${err.message}`);
            throw err;
        }
    }

    /**
     * Deletes a repository from disk and removes it from configuration.
     * @param {string} repoName - The repository name (e.g., "PSBUniverse-core" or "PSBUniverse-core.git")
     */
    deleteRepository(repoName) {
        // Strip .git if present so callers can pass either form
        const cleanName = repoName.replace(/\.git$/, '');
        const repoPath = path.join(this.git.baseDir, `${cleanName}.git`);

        this.logger.info(`Deleting repository: ${cleanName}`);

        if (fs.existsSync(repoPath)) {
            // Recursively delete the bare repository (the cloned mirror)
            fs.rmSync(repoPath, { recursive: true, force: true });
            this.logger.success(`Cloned mirror deleted from disk: ${cleanName}`);
        } else {
            // Nothing on disk to delete. This is not an error: the repository
            // may already have been removed, and the caller still needs to
            // drop it from the saved list so Delete always succeeds.
            this.logger.warn(`No cloned mirror on disk for ${cleanName}; removing the saved entry only`);
        }

        return { success: true };
    }

    /**
     * Refetches a single repository, cloning it first if the mirror is missing.
     *
     * A "refetch" is the manual way to bring a mirror back into a known-good
     * state:
     *   - if GitHubPromotion/<name>.git is missing, it is cloned from DEV;
     *   - the PROD remote is (re)added if absent;
     *   - both DEV (origin) and PROD (prod) are then fetched.
     *
     * Nothing re-clones automatically at startup — this is the only path that
     * recreates a mirror, which is what the Refetch buttons in the UI call.
     *
     * @param {string} repoName - The repository name (e.g., "PSBUniverse-core")
     * @returns {Object} { success, cloned, prodFetched, status }
     */
    async refetchRepository(repoName) {
        const cleanName = repoName.replace(/\.git$/, '');
        const repoPath = path.join(this.git.baseDir, `${cleanName}.git`);

        // The URLs live in the saved configuration, not on disk, so we must
        // look the repository up before we can clone or fetch it.
        const saved = this.loadRepositories().find(r => r.name === cleanName);
        if (!saved) {
            throw new Error(`Repository ${cleanName} is not in the saved list`);
        }

        const needsClone = !fs.existsSync(repoPath);
        this.logger.info(
            needsClone
                ? `Refetch: mirror missing for ${cleanName}, cloning from DEV`
                : `Refetching existing mirror: ${cleanName}`
        );

        try {
            if (needsClone) {
                await this.git.cloneMirror(saved.devRepo, repoPath);
            }

            // Ensure the PROD remote exists. An older mirror may have been
            // cloned before the prod remote was configured, which would make
            // the prod fetch below fail.
            const remotes = await this.git.getRemotes(repoPath);
            if (!remotes.prod && saved.prodRepo) {
                await this.git.addRemote(repoPath, 'prod', saved.prodRepo);
            }

            await this.git.fetchOrigin(repoPath);

            // A PROD repository may legitimately be brand new and empty, so a
            // failed prod fetch is logged but must not fail the whole refetch.
            let prodFetched = true;
            try {
                await this.git.fetchProd(repoPath);
            } catch (err) {
                prodFetched = false;
                this.logger.warn(`Could not fetch prod for ${cleanName} (may be new or empty on PROD): ${err.message}`);
            }

            this.logger.success(`Repository ${cleanName} ${needsClone ? 'cloned and fetched' : 'refetched'}`);
            return { success: true, cloned: needsClone, prodFetched: prodFetched, status: 'ready' };
        } catch (err) {
            this.logger.error(`Failed to refetch repository ${cleanName}: ${err.message}`);
            throw err;
        }
    }

    /**
     * Refetches every repository in the saved list, cloning any whose mirror
     * is missing. This backs the global "Refetch All" button in the header.
     *
     * Each repository is recorded as ready or failed so the caller can report
     * a per-repository summary. One failing repository must never stop the
     * others from being refetched.
     *
     * @returns {Object} { total, results: [{ name, success, cloned, error }] }
     */
    async refetchAllRepositories() {
        const repos = this.loadRepositories();
        const results = [];

        this.logger.info(`Refetching all ${repos.length} saved repositories`);

        for (const repo of repos) {
            try {
                const result = await this.refetchRepository(repo.name);
                repo.status = 'ready';
                results.push({ name: repo.name, success: true, cloned: result.cloned });
            } catch (err) {
                // Mark it failed and carry on with the next repository.
                repo.status = 'failed';
                results.push({ name: repo.name, success: false, error: err.message });
            }
        }

        this.saveRepositories(repos);

        const failed = results.filter(r => !r.success).length;
        if (failed === 0) {
            this.logger.success(`Refetch all complete: ${results.length} repositories`);
        } else {
            this.logger.warn(`Refetch all finished with ${failed} failure(s) out of ${results.length}`);
        }

        return { total: results.length, results: results };
    }

    /**
     * Promotes a branch from DEV (origin) to PROD (prod).
     * @param {string} repoPath - Path to the bare repository
     * @param {string} branch - Branch name to promote
     */
    async promoteBranch(repoPath, branch) {
        await this.git.pushBranch(repoPath, branch, 'prod');
    }

    /**
     * Reverts a specific commit on a branch and pushes to PROD.
     * @param {string} repoPath - Path to the bare repository
     * @param {string} branch - Branch name
     * @param {string} commitHash - Commit hash to revert
     */
    async revertCommit(repoPath, branch, commitHash) {
        await this.git.revertAndPush(repoPath, branch, commitHash);
    }

    /**
     * Returns the commit history for a branch from prod.
     * @param {string} repoPath - Path to the bare repository
     * @param {string} branch - Branch name
     * @param {number} maxCount - Maximum number of commits
     */
    async getHistory(repoPath, branch, maxCount = 50) {
        return await this.git.log(repoPath, branch, maxCount);
    }

    /**
     * Returns the commit history for a branch from DEV (origin).
     * @param {string} repoPath - Path to the bare repository
     * @param {string} branch - Branch name
     * @param {number} maxCount - Maximum number of commits
     */
    async getDevHistory(repoPath, branch, maxCount = 50) {
        return await this.git.logDev(repoPath, branch, maxCount);
    }

    /**
     * Compares DEV (origin) against PROD (prod) for a branch.
     * Returns detailed comparison data including latest commits from both sides.
     * @param {string} repoPath - Path to the bare repository
     * @param {string} branch - Branch name
     * @returns {Object} Comparison result with commits and metadata
     */
    async compareBranches(repoPath, branch) {
        try {
            // Get commits that are in DEV but not in PROD
            const commits = await this.git.compare(repoPath, branch);
            
            // Get latest commit from DEV (origin)
            const devLatest = await this.git.getLatestCommit(repoPath, `refs/heads/${branch}`);
            
            // Get latest commit from PROD (prod)
            const prodLatest = await this.git.getLatestCommit(repoPath, `refs/remotes/prod/${branch}`);
            
            // Count changed files if there are commits
            let changedFiles = 0;
            if (commits.length > 0 && prodLatest && devLatest) {
                changedFiles = await this.git.countChangedFiles(repoPath, prodLatest.hash, devLatest.hash);
            }
            
            return {
                commits: commits,
                devLatest: devLatest,
                prodLatest: prodLatest,
                commitCount: commits.length,
                changedFiles: changedFiles
            };
        } catch (err) {
            this.logger.error(`Failed to compare branches: ${err.message}`);
            throw err;
        }
    }
}

module.exports = RepositoryService;