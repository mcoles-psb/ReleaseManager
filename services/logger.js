const fs = require('fs');
const path = require('path');

/**
 * Logger service that writes log entries to both a rolling file
 * and keeps recent entries in memory for the UI to display.
 *
 * Log files are stored as plain text in the Logs directory
 * with one file per day: YYYY-MM-DD.log
 */
class Logger {
    constructor(logsDir) {
        this.logsDir = logsDir;
        this.recentEntries = [];
        this.maxRecentEntries = 1000;

        // Ensure logs directory exists
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    /**
     * Returns the log file path for today's date.
     */
    getLogFilePath() {
        const date = new Date().toISOString().split('T')[0];
        return path.join(this.logsDir, `${date}.log`);
    }

    /**
     * Formats a log entry with a timestamp and level.
     */
    formatEntry(level, message) {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] [${level}] ${message}`;
    }

    /**
     * Logs a Git command execution with full output details.
     * @param {string} command - The Git command that was executed
     * @param {string} stdout - Standard output from the command
     * @param {string} stderr - Standard error from the command
     * @param {number} exitCode - Exit code of the command
     */
    logGitCommand(command, stdout, stderr, exitCode) {
        this.info(`Git command: ${command}`);
        this.info(`Exit code: ${exitCode}`);
        
        if (stdout && stdout.trim()) {
            this.info(`Git stdout:\n${stdout.trim()}`);
        }
        
        if (stderr && stderr.trim()) {
            this.error(`Git stderr:\n${stderr.trim()}`);
        }
    }

    /**
     * Logs a Git error with full details for debugging.
     * @param {string} operation - The operation that failed
     * @param {Error} error - The error object
     */
    logGitError(operation, error) {
        this.error(`Git operation failed: ${operation}`);
        
        if (error.message) {
            this.error(`Error message: ${error.message}`);
        }
        
        if (error.stdout) {
            this.error(`Git stdout:\n${error.stdout}`);
        }
        
        if (error.stderr) {
            this.error(`Git stderr:\n${error.stderr}`);
        }
        
        if (error.code) {
            this.error(`Exit code: ${error.code}`);
        }
    }

    /**
     * Writes a log entry to the daily log file and keeps it in memory.
     */
    write(level, message) {
        const entry = this.formatEntry(level, message);

        // Append to daily log file
        try {
            fs.appendFileSync(this.getLogFilePath(), entry + '\n', 'utf-8');
        } catch (err) {
            console.error('Failed to write log file:', err.message);
        }

        // Keep in memory for UI
        this.recentEntries.push(entry);
        if (this.recentEntries.length > this.maxRecentEntries) {
            this.recentEntries.shift();
        }
    }

    /**
     * Logs an informational message.
     */
    info(message) {
        this.write('INFO', message);
    }

    /**
     * Logs a warning message.
     */
    warn(message) {
        this.write('WARN', message);
    }

    /**
     * Logs an error message.
     */
    error(message) {
        this.write('ERROR', message);
    }

    /**
     * Logs a success message (INFO level with a SUCCESS marker).
     */
    success(message) {
        this.write('SUCCESS', message);
    }

    /**
     * Returns the most recent log entries, up to maxLines.
     */
    getRecent(maxLines = 200) {
        return this.recentEntries.slice(-maxLines);
    }

    /**
     * Clears all in-memory log entries.
     * Does not delete log files from disk.
     */
    clear() {
        this.recentEntries = [];
    }
}

module.exports = Logger;