const fs = require('fs');
const path = require('path');

/**
 * Compares the structure of two saved databases (read-only).
 *
 * Each database's structure is read from the Postgres catalog through
 * DatabaseService.runReadOnly (READ ONLY transaction, always rolled back),
 * turned into a flat list of items, and the two lists are matched by key.
 * Nothing is ever written to either database.
 */

const CATEGORY_ORDER = ['tables', 'columns', 'keys', 'indexes', 'triggers', 'functions', 'sequences', 'policies'];

const CATEGORY_LABELS = {
    tables: 'Table / view',
    columns: 'Column',
    keys: 'Key / constraint',
    indexes: 'Index',
    triggers: 'Trigger',
    functions: 'Function',
    sequences: 'Sequence',
    policies: 'Policy'
};

// One catalog query per category. $1 is the schema name. toItem turns a row
// into { table, name, key, display, value }: key matches the item across the
// two databases, value decides "Different", display is what the page shows.
const QUERIES = [
    {
        category: 'tables',
        text: `
            SELECT c.relname AS table_name,
                   CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view'
                                  WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END AS kind,
                   c.relrowsecurity AS rls_enabled
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
        toItem: (row) => {
            const display = row.kind.includes('table') ? `${row.kind}, RLS ${row.rls_enabled ? 'on' : 'off'}` : row.kind;
            return { table: row.table_name, name: row.table_name, key: row.table_name, display, value: display };
        }
    },
    {
        category: 'columns',
        text: `
            SELECT c.relname AS table_name, a.attname AS column_name,
                   format_type(a.atttypid, a.atttypmod) AS data_type,
                   a.attnotnull AS not_null,
                   a.attidentity AS identity,
                   a.attgenerated AS generated,
                   pg_get_expr(d.adbin, d.adrelid) AS default_value
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND a.attnum > 0 AND NOT a.attisdropped`,
        toItem: (row) => {
            let display = row.data_type;
            if (row.not_null) display += ' not null';
            if (row.identity === 'a') display += ' identity always';
            if (row.identity === 'd') display += ' identity by default';
            if (row.default_value) display += row.generated === 's' ? ` generated as ${row.default_value}` : ` default ${row.default_value}`;
            return { table: row.table_name, name: row.column_name, key: `${row.table_name}.${row.column_name}`, display, value: display };
        }
    },
    {
        category: 'keys',
        text: `
            SELECT c.relname AS table_name, con.conname AS name,
                   CASE con.contype WHEN 'p' THEN 'primary key' WHEN 'f' THEN 'foreign key' WHEN 'u' THEN 'unique'
                                    WHEN 'c' THEN 'check' WHEN 'x' THEN 'exclusion' END AS kind,
                   pg_get_constraintdef(con.oid) AS definition
            FROM pg_constraint con
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND con.contype IN ('p', 'f', 'u', 'c', 'x')`,
        toItem: (row) => {
            const display = `${row.kind}: ${row.definition}`;
            return { table: row.table_name, name: row.name, key: `${row.table_name}.${row.name}`, display, value: display };
        }
    },
    {
        // Indexes that back a primary key / unique / exclusion rule are left
        // out: the Key / constraint row already covers them.
        category: 'indexes',
        text: `
            SELECT t.relname AS table_name, ic.relname AS name, pg_get_indexdef(ix.indexrelid) AS definition
            FROM pg_index ix
            JOIN pg_class ic ON ic.oid = ix.indexrelid
            JOIN pg_class t ON t.oid = ix.indrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = $1
              AND NOT EXISTS (SELECT 1 FROM pg_constraint con
                              WHERE con.conindid = ix.indexrelid AND con.contype IN ('p', 'u', 'x'))`,
        toItem: (row) => {
            const display = String(row.definition).replace(/ INDEX \S+ ON /, ' INDEX ON ');
            return { table: row.table_name, name: row.name, key: `${row.table_name}.${row.name}`, display, value: display };
        }
    },
    {
        category: 'triggers',
        text: `
            SELECT c.relname AS table_name, tg.tgname AS name, pg_get_triggerdef(tg.oid) AS definition,
                   tg.tgenabled <> 'D' AS enabled
            FROM pg_trigger tg
            JOIN pg_class c ON c.oid = tg.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND NOT tg.tgisinternal`,
        toItem: (row) => {
            const display = `${row.enabled ? '' : '(disabled) '}${row.definition}`;
            return { table: row.table_name, name: row.name, key: `${row.table_name}.${row.name}`, display, value: display };
        }
    },
    {
        // Functions that belong to an installed extension are left out.
        category: 'functions',
        text: `
            SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
                   CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
                   pg_get_functiondef(p.oid) AS definition
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
              AND NOT EXISTS (SELECT 1 FROM pg_depend d
                              WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`,
        toItem: (row) => {
            const lines = String(row.definition || '').split('\n').length;
            return { table: '', name: row.signature, key: row.signature, display: `${row.kind}, ${lines} lines`, value: String(row.definition || '') };
        }
    },
    {
        category: 'sequences',
        text: `
            SELECT s.sequencename AS name, s.data_type::text AS data_type,
                   s.start_value::text AS start_value, s.increment_by::text AS increment_by
            FROM pg_sequences s
            WHERE s.schemaname = $1`,
        toItem: (row) => {
            const display = `${row.data_type}, start ${row.start_value}, step ${row.increment_by}`;
            return { table: '', name: row.name, key: row.name, display, value: display };
        }
    },
    {
        category: 'policies',
        text: `
            SELECT p.tablename AS table_name, p.policyname AS name, p.permissive, p.cmd,
                   array_to_string(p.roles, ', ') AS roles, p.qual, p.with_check
            FROM pg_policies p
            WHERE p.schemaname = $1`,
        toItem: (row) => {
            let display = `${String(row.permissive).toLowerCase()}, ${row.cmd}, to ${row.roles}`;
            if (row.qual) display += `, using ${row.qual}`;
            if (row.with_check) display += `, with check ${row.with_check}`;
            return { table: row.table_name, name: row.name, key: `${row.table_name}.${row.name}`, display, value: display };
        }
    }
];

/**
 * The app a name belongs to, from its prefix: "proj_t_projects" -> "proj_".
 */
function appPrefix(name) {
    const match = /^([a-z0-9]+)_/i.exec(String(name || ''));
    return match ? `${match[1].toLowerCase()}_` : '(other)';
}

function makeRow(status, left, right) {
    const item = left || right;
    let leftText = left ? left.display : '';
    let rightText = right ? right.display : '';
    // Same summary but different details (e.g. a function body): say so.
    if (status === 'different' && leftText === rightText) {
        leftText += ' (details differ)';
        rightText += ' (details differ)';
    }
    return {
        status,
        category: item.category,
        app: appPrefix(item.table || item.name),
        table: item.table || '',
        name: item.name,
        left: leftText,
        right: rightText
    };
}

/**
 * Matches the two item lists and returns only the differences.
 */
function diffItems(leftItems, rightItems) {
    const leftTables = new Set(leftItems.filter(i => i.category === 'tables').map(i => i.name));
    const rightTables = new Set(rightItems.filter(i => i.category === 'tables').map(i => i.name));
    const leftMap = new Map(leftItems.map(i => [`${i.category}|${i.key}`, i]));
    const rightMap = new Map(rightItems.map(i => [`${i.category}|${i.key}`, i]));

    // An item of a table that only one side has is covered by that table's row.
    const coveredByTable = (item) => item.category !== 'tables' && item.table
        && !(leftTables.has(item.table) && rightTables.has(item.table));

    const rows = [];
    for (const [key, left] of leftMap) {
        const right = rightMap.get(key);
        if (!right) {
            if (!coveredByTable(left)) rows.push(makeRow('only-left', left, null));
        } else if (left.value !== right.value) {
            rows.push(makeRow('different', left, right));
        }
    }
    for (const [key, right] of rightMap) {
        if (!leftMap.has(key) && !coveredByTable(right)) rows.push(makeRow('only-right', null, right));
    }

    rows.sort((a, b) =>
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
        || a.table.localeCompare(b.table)
        || a.name.localeCompare(b.name));
    return rows;
}

function countByCategory(leftItems, rightItems) {
    const totals = {};
    CATEGORY_ORDER.forEach(category => { totals[category] = { left: 0, right: 0 }; });
    leftItems.forEach(i => { totals[i.category].left++; });
    rightItems.forEach(i => { totals[i.category].right++; });
    return totals;
}

function csvCell(value) {
    return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

class DatabaseCompareService {
    constructor(databaseService, reportsDir, logger) {
        this.databaseService = databaseService;
        this.reportsDir = reportsDir;
        this.logger = logger;
    }

    /**
     * Reads one database's structure as a flat list of items.
     */
    async getSnapshot(name, schema) {
        const results = await this.databaseService.runReadOnly(
            name,
            QUERIES.map(query => ({ text: query.text, values: [schema] }))
        );
        const items = [];
        QUERIES.forEach((query, index) => {
            results[index].forEach(row => items.push({ category: query.category, ...query.toItem(row) }));
        });
        return items;
    }

    /**
     * Compares two saved connections for one schema.
     */
    async compare(leftName, rightName, schema) {
        const cleanSchema = String(schema || '').trim() || 'public';
        if (!leftName || !rightName) {
            throw new Error('Pick two saved connections to compare.');
        }
        if (leftName === rightName) {
            throw new Error('Pick two different connections to compare.');
        }

        const [leftItems, rightItems] = await Promise.all([
            this.getSnapshot(leftName, cleanSchema),
            this.getSnapshot(rightName, cleanSchema)
        ]);
        const rows = diffItems(leftItems, rightItems);
        this.logger.info(`Database compare: ${leftName} vs ${rightName} (schema ${cleanSchema}): ${rows.length} differences`);

        return {
            left: leftName,
            right: rightName,
            schema: cleanSchema,
            ranAt: new Date().toISOString(),
            rows,
            totals: countByCategory(leftItems, rightItems)
        };
    }

    /**
     * Writes the given compare rows to a CSV file in the Reports folder.
     * Expects { left, right, schema, rows }. Returns { fileName, folder }.
     */
    exportCsv(result) {
        if (!result || !Array.isArray(result.rows)) {
            throw new Error('Run a compare first.');
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const safe = (text) => String(text || '').replace(/[^a-z0-9_-]+/gi, '-');
        const fileName = `db-compare_${safe(result.left)}_vs_${safe(result.right)}_${safe(result.schema)}_${stamp}.csv`;
        const statusText = {
            'only-left': `Only in ${result.left}`,
            'only-right': `Only in ${result.right}`,
            different: 'Different'
        };

        const lines = [
            ['Difference', 'Type', 'App', 'Table', 'Name', result.left, result.right],
            ...result.rows.map(row => [
                statusText[row.status] || row.status,
                CATEGORY_LABELS[row.category] || row.category,
                row.app,
                row.table,
                row.name,
                row.left,
                row.right
            ])
        ].map(cols => cols.map(csvCell).join(','));

        // The BOM lets Excel open the file as UTF-8.
        fs.writeFileSync(path.join(this.reportsDir, fileName), '\uFEFF' + lines.join('\r\n'), 'utf-8');
        this.logger.info(`Database compare exported: Reports/${fileName}`);
        return { fileName, folder: 'Reports' };
    }
}

module.exports = DatabaseCompareService;