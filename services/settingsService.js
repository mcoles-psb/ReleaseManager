const fs = require('fs');
const path = require('path');

/**
 * Manages application configuration stored as JSON files
 * in the Config directory.
 *
 * Settings are persisted to disk and cached in memory
 * for fast access.
 */
class SettingsService {
    constructor(configDir) {
        this.configDir = configDir;
        this.configFile = path.join(configDir, 'settings.json');
        this.cache = null;
    }

    /**
     * Returns the default settings used when no config file exists.
     */
    getDefaults() {
        return {
            devOrg: 'PSBUniverse-DEV',
            prodOrg: 'PSBUniverse-PROD',
            mirrorDirectory: 'GitHubPromotion',
            defaultBranch: 'main',
            logRetentionDays: 30,
            confirmBeforePromote: true,
            confirmBeforeRevert: true,
            gitExecutable: 'git'
        };
    }

    /**
     * Loads settings from disk, or returns defaults if no file exists.
     */
    load() {
        if (this.cache) {
            return this.cache;
        }

        try {
            if (fs.existsSync(this.configFile)) {
                const data = fs.readFileSync(this.configFile, 'utf-8');
                this.cache = { ...this.getDefaults(), ...JSON.parse(data) };
                return this.cache;
            }
        } catch (err) {
            console.error('Failed to load settings:', err.message);
        }

        this.cache = this.getDefaults();
        return this.cache;
    }

    /**
     * Returns all current settings.
     */
    getAll() {
        return this.load();
    }

    /**
     * Saves the provided settings to disk.
     * Merges with existing settings to preserve any values not provided.
     */
    save(settings) {
        const current = this.load();
        this.cache = { ...current, ...settings };

        try {
            fs.writeFileSync(this.configFile, JSON.stringify(this.cache, null, 4), 'utf-8');
        } catch (err) {
            console.error('Failed to save settings:', err.message);
            throw err;
        }
    }

    /**
     * Returns a single setting value by key.
     */
    get(key) {
        const settings = this.load();
        return settings[key] !== undefined ? settings[key] : null;
    }
}

module.exports = SettingsService;