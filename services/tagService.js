/**
 * Manages release tag operations on mirror repositories.
 *
 * Tags are used to mark release points in the production branch.
 * Tags are created locally and pushed to the prod remote.
 */
class TagService {
    constructor(gitService, logger) {
        this.git = gitService;
        this.logger = logger;
    }

    /**
     * Lists all tags in the repository.
     * Returns an array of tag names.
     */
    async listTags(repoPath) {
        await this.git.fetchOrigin(repoPath);
        await this.git.fetchProd(repoPath);
        return await this.git.listTags(repoPath);
    }

    /**
     * Creates a new tag and pushes it to PROD.
     *
     * Steps:
     * 1. Fetch latest from origin (to ensure the commit exists locally)
     * 2. Create the tag
     * 3. Push the tag to prod
     */
    async createTag(repoPath, tagName, commitHash) {
        this.logger.info(`Creating tag ${tagName} at ${commitHash}`);

        await this.git.fetchOrigin(repoPath);
        await this.git.createTag(repoPath, tagName, commitHash);
        await this.git.pushTag(repoPath, tagName, 'prod');

        this.logger.success(`Tag ${tagName} created and pushed to PROD`);
    }

    /**
     * Pushes an existing local tag to the prod remote.
     * Used when a tag was created locally but not yet pushed.
     */
    async pushTag(repoPath, tagName) {
        this.logger.info(`Pushing tag ${tagName} to PROD`);

        await this.git.pushTag(repoPath, tagName, 'prod');

        this.logger.success(`Tag ${tagName} pushed to PROD`);
    }
}

module.exports = TagService;