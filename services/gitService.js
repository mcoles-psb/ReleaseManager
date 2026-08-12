const simpleGit = require('simple-git');

/**
 * Wraps the simple-git library to provide Git operations
 * on bare mirror repositories.
 *
 * All Git operations are performed in the context of a
 * bare repository directory. The application never
 * checks out source code.
 */
class GitService {
    constructor(baseDir, logger) {
        this.baseDir = baseDir;
        this.logger = logger;
    }

    /**
     * Creates a Git instance configured for the given repository path.
     */
    git(repoPath) {
        return simpleGit(repoPath);
    }

    /**
     * Clones a mirror (bare) repository from a remote URL.
     * --mirror ensures all branches, tags, and history are fetched.
     */
    async cloneMirror(repoUrl, repoPath) {
        this.logger.info(`Cloning mirror: ${repoUrl} -> ${repoPath}`);
        try {
            // No repoPath needed for clone — simple-git runs clone from cwd
            // and creates the target directory itself
            await simpleGit().clone(repoUrl, repoPath, ['--mirror']);
            this.logger.success(`Mirror cloned: ${repoPath}`);
        } catch (error) {
            this.logger.logGitError('cloneMirror', error);
            throw error;
        }
    }

    /**
     * Fetches all updates from the origin remote.
     * Used to refresh the mirror before operations.
     */
    async fetchOrigin(repoPath) {
        this.logger.info(`Fetching origin: ${repoPath}`);
        try {
            await this.git(repoPath).raw(['fetch', 'origin', '--prune', '--tags']);
            this.logger.success(`Origin fetched: ${repoPath}`);
        } catch (error) {
            this.logger.logGitError('fetchOrigin', error);
            throw error;
        }
    }

    /**
     * Fetches all updates from the prod remote.
     */
    async fetchProd(repoPath) {
        this.logger.info(`Fetching prod: ${repoPath}`);
        try {
            await this.git(repoPath).raw(['fetch', 'prod', '--prune', '--tags']);
            this.logger.success(`Prod fetched: ${repoPath}`);
        } catch (error) {
            this.logger.logGitError('fetchProd', error);
            throw error;
        }
    }

    /**
     * Pushes a branch to the prod remote.
     * This is the promotion action: DEV -> PROD.
     */
    async pushBranch(repoPath, branch, remote = 'prod') {
        this.logger.info(`Pushing ${branch} to ${remote}`);
        try {
            await this.git(repoPath).push(remote, branch);
            this.logger.success(`Pushed ${branch} to ${remote}`);
        } catch (error) {
            this.logger.logGitError('pushBranch', error);
            throw error;
        }
    }

    /**
     * Reverts a specific commit on the given branch and pushes to prod.
     * Uses git revert to safely undo changes without rewriting history.
     */
    async revertAndPush(repoPath, branch, commitHash) {
        this.logger.info(`Reverting commit ${commitHash} on ${branch}`);

        try {
            // Checkout the branch in the bare repo using worktree
            // In a bare repo, we use git revert with environment variables
            const git = this.git(repoPath);

            // Perform the revert
            await git.raw(['revert', '--no-edit', commitHash]);

            // Push the revert to prod
            await git.push('prod', branch);

            this.logger.success(`Revert pushed: ${commitHash} on ${branch}`);
        } catch (error) {
            this.logger.logGitError('revertAndPush', error);
            throw error;
        }
    }

    /**
     * Returns the latest commit for a specific ref (branch or remote branch).
     * @param {string} repoPath - Path to the repository
     * @param {string} ref - Git ref (e.g., 'refs/heads/main' or 'refs/remotes/prod/main')
     * @returns {Object} Latest commit object
     */
    async getLatestCommit(repoPath, ref) {
        const git = this.git(repoPath);
        try {
            const output = await git.raw([
                'log',
                ref,
                '-1',
                '--pretty=format:%H|%h|%an|%ai|%s'
            ]);
            if (!output.trim()) return null;
            const [hash, abbreviatedHash, author, date, message] = output.split('|');
            return { hash, abbreviatedHash, author, date, message };
        } catch (error) {
            this.logger.logGitError('getLatestCommit', error);
            return null;
        }
    }

    /**
     * Returns the log of commits for a branch in a parseable format.
     * In a mirror repo, PROD history is under refs/remotes/prod/<branch>.
     * Uses git log with a custom format string via raw().
     */
    async log(repoPath, branch, maxCount = 50) {
        const git = this.git(repoPath);
        try {
            const output = await git.raw([
                'log',
                `refs/remotes/prod/${branch}`,
                `--max-count=${maxCount}`,
                '--pretty=format:%H|%h|%an|%ai|%s|%D'
            ]);
            return output.split('\n').filter(line => line.trim()).map(line => {
                const [hash, abbreviatedHash, author, date, message, refs] = line.split('|');
                return { hash, abbreviatedHash, author, date, message, refs: refs || '' };
            });
        } catch (error) {
            this.logger.logGitError('log', error);
            throw error;
        }
    }

    /**
     * Returns the log of commits for a branch on DEV (refs/heads/<branch>).
     * Mirrors log() but reads DEV's local branch ref instead of the prod 
     * remote-tracking ref.
     */
    async logDev(repoPath, branch, maxCount = 50) {
        const git = this.git(repoPath);
        try {
            const output = await git.raw([
                'log',
                `refs/heads/${branch}`,
                `--max-count=${maxCount}`,
                '--pretty=format:%H|%h|%an|%ai|%s|%D'
            ]);
            return output.split('\n').filter(line => line.trim()).map(line => {
                const [hash, abbreviatedHash, author, date, message, refs] = line.split('|');
                return { hash, abbreviatedHash, author, date, message, refs: refs || '' };
            });
        } catch (error) {
            this.logger.logGitError('logDev', error);
            throw error;
        }
    }

    /**
     * Returns commits that are in DEV (refs/heads) but not in PROD (refs/remotes/prod).
     * Used for the compare feature.
     */
    async compare(repoPath, branch) {
        const git = this.git(repoPath);
        const range = `refs/remotes/prod/${branch}..refs/heads/${branch}`;
        try {
            const output = await git.raw([
                'log',
                range,
                '--pretty=format:%H|%h|%an|%ai|%s'
            ]);
            return output.split('\n').filter(line => line.trim()).map(line => {
                const [hash, abbreviatedHash, author, date, message] = line.split('|');
                return { hash, abbreviatedHash, author, date, message };
            });
        } catch (error) {
            this.logger.logGitError('compare', error);
            throw error;
        }
    }

    /**
     * Returns the number of changed files between two commits.
     * @param {string} repoPath - Path to the repository
     * @param {string} fromCommit - Starting commit hash
     * @param {string} toCommit - Ending commit hash
     * @returns {number} Number of changed files
     */
    async countChangedFiles(repoPath, fromCommit, toCommit) {
        const git = this.git(repoPath);
        try {
            const output = await git.raw([
                'diff',
                '--name-only',
                fromCommit,
                toCommit
            ]);
            const files = output.split('\n').filter(line => line.trim());
            return files.length;
        } catch (error) {
            this.logger.logGitError('countChangedFiles', error);
            return 0;
        }
    }

    /**
     * Lists all tags in the repository.
     */
    async listTags(repoPath) {
        const git = this.git(repoPath);
        try {
            const tags = await git.tags();
            return tags.all;
        } catch (error) {
            this.logger.logGitError('listTags', error);
            throw error;
        }
    }

    /**
     * Creates a new tag at the specified commit.
     */
    async createTag(repoPath, tagName, commitHash) {
        const git = this.git(repoPath);
        try {
            await git.addTag(tagName, commitHash);
            this.logger.success(`Tag created: ${tagName}`);
        } catch (error) {
            this.logger.logGitError('createTag', error);
            throw error;
        }
    }

    /**
     * Pushes a tag to the prod remote.
     */
    async pushTag(repoPath, tagName, remote = 'prod') {
        const git = this.git(repoPath);
        try {
            await git.push(remote, tagName);
            this.logger.success(`Tag pushed: ${tagName} to ${remote}`);
        } catch (error) {
            this.logger.logGitError('pushTag', error);
            throw error;
        }
    }

    /**
     * Returns the list of branches available in the repository.
     * Only returns local branches, not remote-tracking refs.
     */
    async listBranches(repoPath) {
        const git = this.git(repoPath);
        try {
            const output = await git.raw(['branch', '--format=%(refname:short)']);
            return output.split('\n')
                .map(b => b.trim())
                .filter(b => b && !b.startsWith('remotes/'));
        } catch (error) {
            this.logger.logGitError('listBranches', error);
            throw error;
        }
    }

    /**
     * Adds a remote to the repository using the native Git command:
     * `git remote add <name> <url>`
     * @param {string} repoPath - Path to the repository
     * @param {string} remoteName - Name of the remote (e.g., 'origin', 'prod')
     * @param {string} remoteUrl - URL of the remote
     */
    async addRemote(repoPath, remoteName, remoteUrl) {
        const git = this.git(repoPath);
        this.logger.info(`Adding remote ${remoteName}: ${remoteUrl}`);
        try {
            await git.raw(['remote', 'add', remoteName, remoteUrl]);
            this.logger.success(`Remote ${remoteName} added: ${remoteUrl}`);
        } catch (error) {
            this.logger.logGitError('addRemote', error);
            throw error;
        }
    }

    /**
     * Returns the remotes of a repository using the native Git command:
     * `git remote -v`
     * @param {string} repoPath - Path to the repository
     * @returns {Promise<Object>} Object mapping remote names to URLs
     */
    async getRemotes(repoPath) {
        const git = this.git(repoPath);
        try {
            const output = await git.raw(['remote', '-v']);
            const remotes = {};
            output.split('\n').forEach(line => {
                if (!line.trim()) return;
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    remotes[parts[0]] = parts[1];
                }
            });
            return remotes;
        } catch (error) {
            this.logger.logGitError('getRemotes', error);
            throw error;
        }
    }

    /**
     * Sets up the remote configuration for a mirror repository.
     * Adds 'origin' and 'prod' remotes if they don't exist.
     */
    async setupRemotes(repoPath, originUrl, prodUrl) {
        try {
            // Check existing remotes
            const remotes = await this.getRemotes(repoPath);
            const hasOrigin = remotes.origin !== undefined;
            const hasProd = remotes.prod !== undefined;

            if (!hasOrigin && originUrl) {
                await this.addRemote(repoPath, 'origin', originUrl);
            }

            if (!hasProd && prodUrl) {
                await this.addRemote(repoPath, 'prod', prodUrl);
            }
        } catch (error) {
            this.logger.logGitError('setupRemotes', error);
            throw error;
        }
    }
}

module.exports = GitService;