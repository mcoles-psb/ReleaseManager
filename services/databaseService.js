const fs = require('fs');
const path = require('path');

/**
 * Saved database connections and read-only queries against them.
 *
 * Connections live in Config/databaseConnections.json as plain text
 * ([{ name, connectionString }]). That file is git-ignored: it holds
 * database passwords and must never be committed.
 *
 * Every query runs inside a READ ONLY transaction that is always rolled
 * back, so the database itself refuses any change. The renderer never sends
 * SQL: only queries written in the main process are run.
 */
class DatabaseService {
    constructor(configDir, logger) {
        this.configFile = path.join(configDir, 'databaseConnections.json');
        this.logger = logger;
    }

    /**
     * Reads the saved connections from disk ([] when there are none).
     */
    loadConnections() {
        try {
            if (fs.existsSync(this.configFile)) {
                const data = JSON.parse(fs.readFileSync(this.configFile, 'utf-8'));
                return Array.isArray(data) ? data : [];
            }
        } catch (err) {
            this.logger.error(`Failed to read database connections: ${err.message}`);
        }
        return [];
    }

    saveConnections(list) {
        fs.writeFileSync(this.configFile, JSON.stringify(list, null, 4), 'utf-8');
    }

    /**
     * The list for the renderer: name and account/host only, never the
     * connection string itself.
     */
    listConnections() {
        return this.loadConnections().map(c => ({ name: c.name, host: describeHost(c.connectionString) }));
    }

    /**
     * Adds a connection, or replaces the one with the same name.
     */
    saveConnection(name, connectionString) {
        const cleanName = String(name || '').trim();
        const cleanString = String(connectionString || '').trim();
        if (!cleanName) {
            throw new Error('Enter a name for the connection, for example QAS or PROD.');
        }
        if (!/^postgres(ql)?:\/\//i.test(cleanString)) {
            throw new Error('The connection string must start with postgresql://');
        }
        const list = this.loadConnections().filter(c => c.name !== cleanName);
        list.push({ name: cleanName, connectionString: cleanString });
        list.sort((a, b) => a.name.localeCompare(b.name));
        this.saveConnections(list);
        this.logger.info(`Database connection saved: ${cleanName}`);
    }

    /**
     * Removes a saved connection. Nothing in the database is touched.
     */
    removeConnection(name) {
        const list = this.loadConnections();
        const kept = list.filter(c => c.name !== name);
        if (kept.length !== list.length) {
            this.saveConnections(kept);
            this.logger.info(`Database connection removed: ${name}`);
        }
    }

    getConnectionString(name) {
        const found = this.loadConnections().find(c => c.name === name);
        if (!found) {
            throw new Error(`No saved database connection named "${name}".`);
        }
        return found.connectionString;
    }

    /**
     * Runs the given queries, in order, inside one READ ONLY transaction that
     * is always rolled back. Returns one array of rows per query.
     * @param {string} name - Saved connection name
     * @param {{ text: string, values?: any[] }[]} queries
     */
    async runReadOnly(name, queries) {
        const { Client } = require('pg');
        const client = new Client({
            connectionString: stripSslParams(this.getConnectionString(name)),
            // Supabase uses its own certificate authority; this tool only reads.
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 15000,
            statement_timeout: 60000,
            application_name: 'PSB Release Manager (read-only)'
        });
        await client.connect();
        try {
            await client.query('BEGIN TRANSACTION READ ONLY');
            const results = [];
            for (const query of queries) {
                const res = await client.query(query.text, query.values || []);
                results.push(res.rows);
            }
            return results;
        } finally {
            try {
                await client.query('ROLLBACK');
            } catch (err) {
                // The connection may already be gone; nothing to undo.
            }
            await client.end().catch(() => {});
        }
    }

    /**
     * Connects read-only and reports the database name and Postgres version.
     * Never throws: returns { ok: false, message } on failure.
     */
    async testConnection(name) {
        try {
            const [rows] = await this.runReadOnly(name, [{
                text: "SELECT current_database() AS database, current_setting('server_version') AS version, current_setting('transaction_read_only') AS read_only"
            }]);
            const row = rows[0] || {};
            this.logger.info(`Database connection OK: ${name} (${row.database}, Postgres ${row.version})`);
            return { ok: true, database: String(row.database || ''), version: String(row.version || ''), readOnly: row.read_only === 'on' };
        } catch (err) {
            this.logger.error(`Database connection failed: ${name}: ${err.message}`);
            return { ok: false, message: err.message };
        }
    }
}

/**
 * "user @ host:port" from a connection string, without the password.
 */
function describeHost(connectionString) {
    try {
        const url = new URL(connectionString);
        const user = decodeURIComponent(url.username || '');
        return `${user ? user + ' @ ' : ''}${url.hostname}${url.port ? ':' + url.port : ''}`;
    } catch (err) {
        return 'Unreadable connection string';
    }
}

/**
 * Removes SSL settings from the connection string so the ssl option above is
 * the one used (settings in the string would override it).
 */
function stripSslParams(connectionString) {
    try {
        const url = new URL(connectionString);
        ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert'].forEach(key => url.searchParams.delete(key));
        return url.toString();
    } catch (err) {
        return connectionString;
    }
}

module.exports = DatabaseService;