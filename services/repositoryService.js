/**
 * Provides high-level repository operations for managing Git bare mirror repositories.
 *
 * This service handles:
 * - Loading and saving repository configuration
 * - Cloning new repositories as bare mirrors
 * - Deleting repositories
 * - Verifying repository configuration
 * - Refreshing repository data
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
        try {
            // Standardize: strip .git if present
            const cleanName = repoName.replace(/\.git$/, '');
            const repoPath = path.join(this.git.baseDir, `${cleanName}.git`);

            if (!fs.existsSync(repoPath)) {
                throw new Error(`Repository ${cleanName} not found at ${repoPath}`);
            }

            this.logger.info(`Deleting repository: ${cleanName}`);

            // Recursively delete the bare repository
            fs.rmSync(repoPath, { recursive: true, force: true });

            this.logger.success(`Repository ${cleanName} deleted successfully`);
            return { success: true };
        } catch (err) {
            this.logger.error(`Failed to delete repository ${repoName}: ${err.message}`);
            throw err;
        }
    }

    /**
     * Verifies that a repository is properly configured with both remotes.
     * @param {string} repoName - The repository name (e.g., "PSBUniverse-core" or "PSBUniverse-core.git")
     * @returns {Object} Verification result with status and details
     */
    async verifyRepository(repoName) {
        try {
            // Standardize: strip .git if present
            const cleanName = repoName.replace(/\.git$/, '');
            const repoPath = path.join(this.git.baseDir, `${cleanName}.git`);

            if (!fs.existsSync(repoPath)) {
                return {
                    valid: false,
                    error: 'Repository directory not found'
                };
            }

            // Check if it's a valid bare git repository
            const isBare = fs.existsSync(path.join(repoPath, 'HEAD'));
            if (!isBare) {
                return {
                    valid: false,
                    error: `${cleanName} is not a valid Git repository`
                };
            }

            // Get remotes
            const remotes = await this.git.getRemotes(repoPath);

            const hasOrigin = remotes.origin !== undefined;
            const hasProd = remotes.prod !== undefined;

            if (!hasOrigin || !hasProd) {
                return {
                    valid: false,
                    error: `Missing remotes. Found: ${Object.keys(remotes).join(', ')}`,
                    remotes: remotes
                };
            }

            return {
                valid: true,
                remotes: remotes
            };
        } catch (err) {
            this.logger.error(`Failed to verify repository ${repoName}: ${err.message}`);
            return {
                valid: false,
                error: err.message
            };
        }
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

    /**
     * Refreshes a repository by fetching the latest data from origin AND prod.
     * @param {string} repoName - The repository name (e.g., "PSBUniverse-core" or "PSBUniverse-core.git")
     * @returns {Object} Result object with success status
     */
    async refreshRepository(repoName) {
        try {
            // Standardize: strip .git if present
            const cleanName = repoName.replace(/\.git$/, '');
            const repoPath = path.join(this.git.baseDir, `${cleanName}.git`);

            if (!fs.existsSync(repoPath)) {
                throw new Error(`Repository ${cleanName} not found`);
            }

            this.logger.info(`Refreshing repository: ${cleanName}`);

            // Fetch from origin (DEV)
            await this.git.fetchOrigin(repoPath);
            this.logger.info(`Fetched origin for ${cleanName}`);

            // Fetch from prod (PROD), but don't fail if prod doesn't exist yet
            try {
                await this.git.fetchProd(repoPath);
                this.logger.info(`Fetched prod for ${cleanName}`);
            } catch (err) {
                this.logger.warn(`Prod remote not available for ${cleanName}: ${err.message}`);
            }

            this.logger.success(`Repository ${cleanName} refreshed successfully`);
            return { success: true, status: 'ready' };
        } catch (err) {
            this.logger.error(`Failed to refresh repository ${repoName}: ${err.message}`);
            throw err;
        }
    }
}

module.exports = RepositoryService;