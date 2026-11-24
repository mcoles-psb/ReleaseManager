/**
 * Builds a SQL script that makes a TARGET database match a SOURCE database
 * for the Database Compare rows ticked. TEXT ONLY: Release Manager never runs it.
 *
 * How the script runs (Postgres, for example the Supabase SQL editor):
 *  - It is ONE anonymous DO block, so it is all-or-nothing in any tool.
 *    Nothing is stored in the database (no stored functions are created).
 *  - PREVIEW by default (rm__apply := false): every step runs and is reported,
 *    then everything is rolled back. The report is the error message, because
 *    raising that error is what rolls the changes back.
 *  - APPLY (rm__apply := true): the changes are kept only when no step FAILED.
 *    The report is then shown as rows by the SELECT after the block.
 *  - Each step runs in its own sub-transaction (BEGIN ... EXCEPTION): a step
 *    that fails is undone and reported, and the other steps still run.
 *  - Each step looks first: already done -> SKIPPED (safe to run twice).
 *  - Data checks run before a change: if it would change, cut off or lose a
 *    value, the step FAILS with the reason. A column that cannot be made
 *    required yet (empty values) is a NOTE, which does not block the apply.
 *  - Nothing is ever removed: no table, view or column is dropped. Keys,
 *    indexes, policies and triggers that differ are dropped and re-created in
 *    one step, so a failure puts the old one back.
 */

// Script sections, in the order they must run.
const SECTIONS = [
    ['types', 'Types (enums and domains)'],
    ['sequences', 'Sequences'],
    ['tables', 'New tables'],
    ['columns', 'Columns'],
    ['keys', 'Primary keys, unique and check rules'],
    ['foreignKeys', 'Foreign keys'],
    ['indexes', 'Indexes'],
    ['functions', 'Functions'],
    ['views', 'Views'],
    ['rls', 'Row level security on new tables'],
    ['policies', 'Policies'],
    ['triggers', 'Triggers']
];

/** Quotes an identifier ("name"), so reserved words and capitals are safe. */
function qi(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
}

/** Quotes a text value ('text'). */
function lit(text) {
    return `'${String(text).replace(/'/g, "''")}'`;
}

/** Removes trailing semicolons and spaces. */
function trimSql(sql) {
    return String(sql || '').trim().replace(/;+\s*$/, '');
}

/** One statement ending with exactly one semicolon. */
function endStatement(sql) {
    return `${trimSql(sql)};`;
}

/** Puts "-- " in front of every line. */
function commented(text) {
    return String(text).split('\n').map(line => `-- ${line}`).join('\n');
}

/** Wraps text in a dollar quote whose tag does not appear in the text. */
function dollarQuote(text, base) {
    for (let n = 0; ; n++) {
        const tag = `$${base}${n ? n : ''}$`;
        if (!text.includes(tag)) return `${tag}${text}${tag}`;
    }
}

/** A commented-out REVIEW note: notes first, then the statements to uncomment. */
function reviewNote(title, notes, statements) {
    return [
        `-- REVIEW: ${title}`,
        ...notes.map(note => `--   ${note}`),
        ...statements.map(statement => commented(statement))
    ].join('\n');
}

/**
 * @param {object} options
 * @param {string} options.schema
 * @param {string} options.sourceName
 * @param {string} options.targetName
 * @param {object[]} options.sourceItems - compare items (with .raw) of the source
 * @param {object[]} options.targetItems - compare items (with .raw) of the target
 * @param {object[]} options.rows - compare rows to script (with .id)
 * @param {string} options.missingStatus - row status meaning "only in source"
 * @param {boolean} options.includeFunctions
 * @param {object} options.labels - category labels
 * @returns {{ script: string, liveCount: number, reviewCount: number, onlyTargetCount: number, skipped: number }}
 */
function buildScript(options) {
    const { schema, sourceName, targetName, sourceItems, targetItems, rows, missingStatus, includeFunctions, labels } = options;

    const qualified = (name) => `${qi(schema)}.${qi(name)}`;
    const regclass = (name) => `to_regclass(${lit(qualified(name))})`;
    const procedure = (signature) => {
        const open = signature.indexOf('(');
        return `to_regprocedure(${lit(`${qi(schema)}.${qi(signature.slice(0, open))}${signature.slice(open)}`)})`;
    };
    const byId = (items) => new Map(items.map(item => [`${item.category}|${item.key}`, item]));
    const sourceById = byId(sourceItems);
    const targetById = byId(targetItems);

    const steps = {};
    SECTIONS.forEach(([key]) => { steps[key] = []; });
    const review = [];
    const onlyTarget = [];
    const manual = [];
    let skipped = 0;
    // Each sequence is added once, even when its own row and a table or
    // column that uses it are both in the script.
    const addedSequences = new Set();

    const isCode = (category) => category === 'functions' || category === 'triggers';
    const rowLabel = (row) => `${labels[row.category] || row.category}: ${row.table && row.table !== row.name ? `${row.table}.` : ''}${row.name}`;

    // Catalog lookups that tell a step it is already done (it is then SKIPPED).
    const has = {
        type: (name) => `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ${lit(schema)} AND t.typname = ${lit(name)}`,
        relation: (name) => `SELECT 1 WHERE ${regclass(name)} IS NOT NULL`,
        column: (table, column, extra = '') => `SELECT 1 FROM pg_attribute a WHERE a.attrelid = ${regclass(table)} AND a.attname = ${lit(column)} AND NOT a.attisdropped${extra}`,
        columnDefault: (table, column, expression) => `SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = ${regclass(table)} AND a.attname = ${lit(column)} AND pg_get_expr(d.adbin, d.adrelid) = ${lit(expression)}`,
        constraint: (table, name, extra = '') => `SELECT 1 FROM pg_constraint c WHERE c.conrelid = ${regclass(table)} AND c.conname = ${lit(name)}${extra}`,
        policy: (table, name, extra = '') => `SELECT 1 FROM pg_policies p WHERE p.schemaname = ${lit(schema)} AND p.tablename = ${lit(table)} AND p.policyname = ${lit(name)}${extra}`,
        trigger: (table, name, extra = '') => `SELECT 1 FROM pg_trigger t WHERE t.tgrelid = ${regclass(table)} AND t.tgname = ${lit(name)}${extra}`,
        rls: (table) => `SELECT 1 FROM pg_class c WHERE c.oid = ${regclass(table)} AND c.relrowsecurity`,
        enumValue: (type, value) => `SELECT 1 FROM pg_enum e WHERE e.enumtypid = to_regtype(${lit(qualified(type))}) AND e.enumlabel = ${lit(value)}`
    };

    /**
     * Adds a step. exists: query that finds it already done (SKIPPED).
     * checks: [{ kind: 'fail' | 'note', when, message }] — when the query finds
     * a row, 'fail' stops the step (FAILED) and 'note' leaves it (NOTE).
     */
    function addStep(section, label, { exists = null, checks = [], statements }) {
        steps[section].push({ label, exists, checks, statements });
    }

    // ── Things the target is missing ───────────────────────────────────────

    function columnDefinition(raw, allowNotNull) {
        let sql = `${qi(raw.column_name)} ${raw.data_type}`;
        if (raw.generated === 's' && raw.default_value) sql += ` GENERATED ALWAYS AS (${raw.default_value}) STORED`;
        else if (raw.identity === 'a') sql += ' GENERATED ALWAYS AS IDENTITY';
        else if (raw.identity === 'd') sql += ' GENERATED BY DEFAULT AS IDENTITY';
        else if (raw.default_value) sql += ` DEFAULT ${raw.default_value}`;
        if (raw.not_null && allowNotNull && !raw.identity) sql += ' NOT NULL';
        return sql;
    }

    function addKey(raw) {
        addStep(raw.kind === 'foreign key' ? 'foreignKeys' : 'keys', `Add ${raw.kind} ${raw.name} on ${raw.table_name}`, {
            exists: has.constraint(raw.table_name, raw.name),
            statements: [`ALTER TABLE ${qualified(raw.table_name)} ADD CONSTRAINT ${qi(raw.name)} ${raw.definition}`]
        });
    }

    function addIndex(raw) {
        addStep('indexes', `Add index ${raw.name} on ${raw.table_name}`, {
            exists: has.relation(raw.name),
            statements: [raw.definition]
        });
    }

    function policyStatement(raw) {
        let sql = `CREATE POLICY ${qi(raw.name)} ON ${qualified(raw.table_name)} AS ${raw.permissive} FOR ${raw.cmd} TO ${raw.roles}`;
        if (raw.qual) sql += ` USING (${raw.qual})`;
        if (raw.with_check) sql += ` WITH CHECK (${raw.with_check})`;
        return sql;
    }

    function addPolicy(raw) {
        addStep('policies', `Add policy ${raw.name} on ${raw.table_name}`, {
            exists: has.policy(raw.table_name, raw.name),
            statements: [policyStatement(raw)]
        });
    }

    function addTrigger(raw) {
        if (!includeFunctions) {
            skipped++;
            return;
        }
        addStep('triggers', `Add trigger ${raw.name} on ${raw.table_name}`, {
            exists: has.trigger(raw.table_name, raw.name),
            statements: [raw.definition]
        });
    }

    // A required column that may hold empty values: made required only when
    // it has none, otherwise left as a NOTE (does not block the apply).
    function addMakeRequired(table, column) {
        addStep('columns', `Make ${table}.${column} required`, {
            exists: has.column(table, column, ' AND a.attnotnull'),
            checks: [{
                kind: 'note',
                when: `SELECT 1 FROM ${qualified(table)} WHERE ${qi(column)} IS NULL`,
                message: 'some rows have no value yet, so it is not made required. Fill them in, then run the script again.'
            }],
            statements: [`ALTER TABLE ${qualified(table)} ALTER COLUMN ${qi(column)} SET NOT NULL`]
        });
    }

    function addSequence(raw) {
        if (addedSequences.has(raw.name)) return;
        addedSequences.add(raw.name);
        addStep('sequences', `Add sequence ${raw.name}`, {
            exists: has.relation(raw.name),
            statements: [
                `CREATE SEQUENCE ${qualified(raw.name)} AS ${raw.data_type}`
                + ` INCREMENT BY ${raw.increment_by} MINVALUE ${raw.min_value} MAXVALUE ${raw.max_value}`
                + ` START WITH ${raw.start_value} CACHE ${raw.cache_size}${raw.cycle ? ' CYCLE' : ' NO CYCLE'}`
            ]
        });
    }

    /**
     * The source sequence a column's default takes its numbers from
     * (nextval('name'::regclass)), or null when there is none in this schema.
     */
    function sequenceOf(column) {
        const match = /nextval\('((?:[^']|'')+)'::regclass\)/.exec(String(column.default_value || ''));
        if (!match) return null;
        let name = match[1].replace(/''/g, "'");
        for (const prefix of [`${schema}.`, `${qi(schema)}.`]) {
            if (name.startsWith(prefix)) name = name.slice(prefix.length);
        }
        if (/^".*"$/.test(name)) name = name.slice(1, -1).replace(/""/g, '"');
        const found = sourceItems.find(i => i.category === 'sequences' && i.raw.name === name);
        return found ? found.raw : null;
    }

    /**
     * Adds the sequences these columns take numbers from (they must exist
     * before the table or column) and returns the statements that tie each one
     * to its column, as on the source (what serial sets up: OWNED BY).
     */
    function sequencesFor(table, columns) {
        const ownedBy = [];
        columns.forEach(column => {
            const sequence = sequenceOf(column);
            if (!sequence) return;
            addSequence(sequence);
            if (sequence.owned_table === table && sequence.owned_column === column.column_name) {
                ownedBy.push(`ALTER SEQUENCE ${qualified(sequence.name)} OWNED BY ${qualified(table)}.${qi(column.column_name)}`);
            }
        });
        return ownedBy;
    }

    function addNewTable(item) {
        const raw = item.raw;
        if (raw.kind === 'view' || raw.kind === 'materialized view') {
            const create = raw.kind === 'view' ? 'CREATE OR REPLACE VIEW' : 'CREATE MATERIALIZED VIEW';
            addStep('views', `Add ${raw.kind} ${raw.table_name}`, {
                exists: has.relation(raw.table_name),
                statements: [`${create} ${qualified(raw.table_name)} AS\n${trimSql(raw.view_definition)}`]
            });
            return;
        }
        if (raw.kind !== 'table') {
            manual.push(`-- ${raw.kind} ${raw.table_name}: not scripted, create it by hand.`);
            return;
        }

        // Everything of a new table comes from the source, since the compare
        // rows only list the table itself.
        const of = (category) => sourceItems
            .filter(i => i.category === category && i.table === raw.table_name)
            .map(i => i.raw);
        const columns = of('columns').sort((a, b) => a.attnum - b.attnum);
        const ownedBy = sequencesFor(raw.table_name, columns);
        addStep('tables', `Add table ${raw.table_name}`, {
            exists: has.relation(raw.table_name),
            statements: [
                `CREATE TABLE ${qualified(raw.table_name)} (\n`
                + columns.map(column => `    ${columnDefinition(column, true)}`).join(',\n')
                + '\n)',
                ...ownedBy
            ]
        });
        of('keys').forEach(addKey);
        of('indexes').forEach(addIndex);
        if (raw.rls_enabled) {
            addStep('rls', `Turn on row level security for ${raw.table_name}`, {
                exists: has.rls(raw.table_name),
                statements: [`ALTER TABLE ${qualified(raw.table_name)} ENABLE ROW LEVEL SECURITY`]
            });
        }
        of('policies').forEach(addPolicy);
        of('triggers').forEach(addTrigger);
    }

    function addNewColumn(raw) {
        // Required with no default would fail on a table that already has rows:
        // it is added as optional, then a separate step makes it required.
        const allowNotNull = Boolean(raw.default_value) || Boolean(raw.identity) || raw.generated === 's';
        const ownedBy = sequencesFor(raw.table_name, [raw]);
        addStep('columns', `Add column ${raw.table_name}.${raw.column_name}`, {
            exists: has.column(raw.table_name, raw.column_name),
            statements: [`ALTER TABLE ${qualified(raw.table_name)} ADD COLUMN ${columnDefinition(raw, allowNotNull)}`, ...ownedBy]
        });
        if (raw.not_null && !allowNotNull) addMakeRequired(raw.table_name, raw.column_name);
    }

    function addMissing(item) {
        const raw = item.raw;
        switch (item.category) {
            case 'types': {
                let statement;
                if (raw.kind === 'enum') {
                    statement = `CREATE TYPE ${qualified(raw.name)} AS ENUM (${(raw.enum_values || []).map(lit).join(', ')})`;
                } else {
                    statement = `CREATE DOMAIN ${qualified(raw.name)} AS ${raw.base_type}`;
                    if (raw.default_value) statement += ` DEFAULT ${raw.default_value}`;
                    if (raw.not_null) statement += ' NOT NULL';
                    if (raw.checks) statement += ` ${raw.checks}`;
                }
                addStep('types', `Add ${raw.kind} type ${raw.name}`, { exists: has.type(raw.name), statements: [statement] });
                break;
            }
            case 'sequences':
                addSequence(raw);
                break;
            case 'tables':
                addNewTable(item);
                break;
            case 'columns':
                addNewColumn(raw);
                break;
            case 'keys':
                addKey(raw);
                break;
            case 'indexes':
                addIndex(raw);
                break;
            case 'policies':
                addPolicy(raw);
                break;
            case 'triggers':
                addTrigger(raw);
                break;
            case 'functions':
                addStep('functions', `Add ${raw.kind} ${raw.signature}`, {
                    exists: `SELECT 1 WHERE ${procedure(raw.signature)} IS NOT NULL`,
                    statements: [raw.definition]
                });
                break;
            default:
                manual.push(`-- ${labels[item.category] || item.category}: ${item.name}: not scripted, add it by hand.`);
        }
    }

    // ── Things that exist on both sides but differ ─────────────────────────

    function addColumnChanges(src, tgt) {
        const s = src.raw;
        const t = tgt.raw;
        const table = s.table_name;
        const column = s.column_name;
        const where = qualified(table);
        const col = qi(column);
        const name = `${table}.${column}`;
        const head = [`source (${sourceName}): ${src.display}`, `target (${targetName}): ${tgt.display}`];

        if (!s.not_null && t.not_null) {
            addStep('columns', `Make ${name} optional`, {
                exists: has.column(table, column, ' AND NOT a.attnotnull'),
                statements: [`ALTER TABLE ${where} ALTER COLUMN ${col} DROP NOT NULL`]
            });
        }

        if (s.data_type !== t.data_type) {
            if (s.generated === 's' || t.generated === 's') {
                review.push(reviewNote(`column ${name}`, [...head, 'A generated column changes type: change it by hand.'], []));
            } else {
                // A default that cannot follow the new type would block it: it is
                // taken off, the type changed, and the default put back.
                const hasDefault = Boolean(t.default_value) && !t.identity;
                const statements = [];
                if (hasDefault) statements.push(`ALTER TABLE ${where} ALTER COLUMN ${col} DROP DEFAULT`);
                statements.push(`ALTER TABLE ${where} ALTER COLUMN ${col} TYPE ${s.data_type} USING ${col}::${s.data_type}`);
                if (hasDefault) statements.push(`ALTER TABLE ${where} ALTER COLUMN ${col} SET DEFAULT ${t.default_value}`);
                addStep('columns', `Change ${name} from ${t.data_type} to ${s.data_type}`, {
                    exists: has.column(table, column, ` AND format_type(a.atttypid, a.atttypmod) = ${lit(s.data_type)}`),
                    checks: [{
                        kind: 'fail',
                        // Every value is converted to the new type and back: if any
                        // comes back different, it would be rounded or cut off.
                        when: `SELECT 1 FROM ${where} WHERE ${col} IS NOT NULL AND (${col}::${s.data_type})::${t.data_type} IS DISTINCT FROM ${col}`,
                        message: `${name}: some values would change, be cut off or not fit in ${s.data_type}. Nothing was changed.`
                    }],
                    statements
                });
            }
        }

        const plainDefault = (raw) => (raw.identity || raw.generated === 's') ? '' : (raw.default_value || '');
        if (plainDefault(s) !== plainDefault(t) && !s.identity && s.generated !== 's') {
            if (plainDefault(s)) {
                addStep('columns', `Set the default of ${name} to ${s.default_value}`, {
                    exists: has.columnDefault(table, column, s.default_value),
                    statements: [`ALTER TABLE ${where} ALTER COLUMN ${col} SET DEFAULT ${s.default_value}`]
                });
            } else {
                addStep('columns', `Remove the default of ${name}`, {
                    exists: has.column(table, column, ' AND NOT a.atthasdef'),
                    statements: [`ALTER TABLE ${where} ALTER COLUMN ${col} DROP DEFAULT`]
                });
            }
        }

        if (s.not_null && !t.not_null) addMakeRequired(table, column);

        if ((s.identity || '') !== (t.identity || '') || (s.generated || '') !== (t.generated || '')) {
            review.push(reviewNote(`column ${name}`, [...head, 'Identity / generated setting differs: change it by hand.'], []));
        }
    }

    function addDifferent(src, tgt) {
        const s = src.raw;
        const t = tgt.raw;
        const head = [`source (${sourceName}): ${src.display}`, `target (${targetName}): ${tgt.display}`];

        switch (src.category) {
            case 'types': {
                if (s.kind === 'enum' && t.kind === 'enum') {
                    const sourceValues = s.enum_values || [];
                    const targetValues = t.enum_values || [];
                    const missing = sourceValues.filter(value => !targetValues.includes(value));
                    missing.forEach(value => addStep('types', `Add value ${value} to type ${s.name}`, {
                        exists: has.enumValue(s.name, value),
                        statements: [`ALTER TYPE ${qualified(s.name)} ADD VALUE ${lit(value)}`]
                    }));
                    const extra = targetValues.filter(value => !sourceValues.includes(value));
                    if (extra.length) {
                        review.push(reviewNote(`type ${s.name}`, [...head, `Values only on the target (left as they are): ${extra.join(', ')}`], []));
                    } else if (!missing.length) {
                        review.push(reviewNote(`type ${s.name}`, [...head, 'The order of the values differs: change it by hand if it matters.'], []));
                    }
                    return;
                }
                review.push(reviewNote(`type ${s.name}`, [...head, 'Change it by hand.'], []));
                return;
            }
            case 'tables': {
                if (s.kind === 'view' && t.kind === 'view' && (s.view_definition || '') !== (t.view_definition || '')) {
                    addStep('views', `Update view ${s.table_name}`, {
                        exists: `SELECT 1 WHERE pg_get_viewdef(${regclass(s.table_name)}, true) = ${lit(s.view_definition)}`,
                        statements: [`CREATE OR REPLACE VIEW ${qualified(s.table_name)} AS\n${trimSql(s.view_definition)}`]
                    });
                }
                const notes = [];
                const statements = [];
                if (s.kind === 'materialized view' && t.kind === 'materialized view' && (s.view_definition || '') !== (t.view_definition || '')) {
                    notes.push('The materialized view definition differs. It holds data, so drop and re-create it by hand.');
                }
                if (s.rls_enabled && !t.rls_enabled) {
                    notes.push('RLS is on in the source only. Turning it on blocks app users that no policy allows (the service key is not affected). Uncomment to apply:');
                    statements.push(`ALTER TABLE ${qualified(s.table_name)} ENABLE ROW LEVEL SECURITY;`);
                }
                if (!s.rls_enabled && t.rls_enabled) notes.push('RLS is on in the target only: left as it is.');
                if (s.kind !== t.kind) notes.push('One side is a table and the other a view: change it by hand.');
                if (notes.length) review.push(reviewNote(`${s.kind} ${s.table_name}`, [...head, ...notes], statements));
                return;
            }
            case 'columns':
                addColumnChanges(src, tgt);
                return;
            case 'keys':
                // Dropped and re-created in one step: if the rows do not meet the
                // source rule, the step fails and the old rule is put back.
                addStep(s.kind === 'foreign key' ? 'foreignKeys' : 'keys', `Replace ${s.kind} ${s.name} on ${s.table_name}`, {
                    exists: has.constraint(s.table_name, s.name, ` AND pg_get_constraintdef(c.oid) = ${lit(s.definition)}`),
                    statements: [
                        `ALTER TABLE ${qualified(s.table_name)} DROP CONSTRAINT ${qi(s.name)}`,
                        `ALTER TABLE ${qualified(s.table_name)} ADD CONSTRAINT ${qi(s.name)} ${s.definition}`
                    ]
                });
                return;
            case 'indexes':
                addStep('indexes', `Replace index ${s.name} on ${s.table_name}`, {
                    exists: `SELECT 1 WHERE pg_get_indexdef(${regclass(s.name)}) = ${lit(s.definition)}`,
                    statements: [`DROP INDEX ${qualified(s.name)}`, s.definition]
                });
                return;
            case 'policies':
                addStep('policies', `Replace policy ${s.name} on ${s.table_name}`, {
                    exists: has.policy(s.table_name, s.name,
                        ` AND p.permissive = ${lit(s.permissive)} AND p.cmd = ${lit(s.cmd)}`
                        + ` AND array_to_string(p.roles, ', ') = ${lit(s.roles)}`
                        + ` AND coalesce(p.qual, '') = ${lit(s.qual || '')} AND coalesce(p.with_check, '') = ${lit(s.with_check || '')}`),
                    statements: [`DROP POLICY ${qi(s.name)} ON ${qualified(s.table_name)}`, policyStatement(s)]
                });
                return;
            case 'triggers':
                addStep('triggers', `Replace trigger ${s.name} on ${s.table_name}`, {
                    exists: has.trigger(s.table_name, s.name, ` AND pg_get_triggerdef(t.oid) = ${lit(s.definition)}`),
                    statements: [`DROP TRIGGER ${qi(s.name)} ON ${qualified(s.table_name)}`, s.definition]
                });
                return;
            case 'functions':
                addStep('functions', `Update ${s.kind} ${s.signature}`, {
                    exists: `SELECT 1 WHERE pg_get_functiondef(${procedure(s.signature)}) = ${lit(s.definition)}`,
                    statements: [s.definition]
                });
                return;
            default:
                review.push(reviewNote(`${labels[src.category] || src.category} ${src.name}`, [...head, 'Change it by hand.'], []));
        }
    }

    // ── Walk the rows ──────────────────────────────────────────────────────

    rows.forEach(row => {
        if (!includeFunctions && isCode(row.category)) {
            skipped++;
            return;
        }
        if (row.status === missingStatus) {
            const item = sourceById.get(row.id);
            if (item) addMissing(item);
        } else if (row.status === 'different') {
            const src = sourceById.get(row.id);
            const tgt = targetById.get(row.id);
            if (src && tgt) addDifferent(src, tgt);
        } else {
            onlyTarget.push(`-- ${rowLabel(row)}`);
        }
    });

    // ── Write the script ───────────────────────────────────────────────────

    /** One step as PL/pgSQL, in its own sub-transaction. */
    function renderStep(step, number) {
        const label = lit(step.label);
        const report = (result, extra) =>
            `rm__report := rm__report || format(E'\\n%s. %s %s', rm__step, rpad(${lit(result)}, 8), ${label}${extra ? ` || ${extra}` : ''});`;

        const branches = [];
        if (step.exists) {
            branches.push({ when: step.exists, body: [report('SKIPPED', lit(' (already done)'))] });
        }
        step.checks.filter(check => check.kind === 'note').forEach(check => {
            branches.push({ when: check.when, body: ['rm__notes := rm__notes + 1;', report('NOTE', lit(`: ${check.message}`))] });
        });

        const work = [];
        step.checks.filter(check => check.kind === 'fail').forEach(check => {
            work.push(`IF EXISTS (${check.when}) THEN`, `    RAISE EXCEPTION USING MESSAGE = ${lit(check.message)};`, 'END IF;');
        });
        // EXECUTE runs each statement exactly as written (no variable swaps).
        step.statements.forEach(statement => work.push(`EXECUTE ${dollarQuote(trimSql(statement), 'rm_sql')};`));
        work.push(report('OK'));

        const inner = [];
        if (branches.length) {
            branches.forEach((branch, index) => {
                inner.push(`${index === 0 ? 'IF' : 'ELSIF'} EXISTS (${branch.when}) THEN`, ...branch.body.map(line => `    ${line}`));
            });
            inner.push('ELSE', ...work.map(line => `    ${line}`), 'END IF;');
        } else {
            inner.push(...work);
        }

        // Only each line's start is indented: a statement's own text (a view or
        // function body) stays exactly as it is.
        return [
            `    -- Step ${number}: ${step.label}`,
            `    rm__step := ${number};`,
            '    BEGIN',
            ...inner.map(line => `        ${line}`),
            '    EXCEPTION WHEN OTHERS THEN',
            '        rm__failed := rm__failed + 1;',
            `        ${report('FAILED', "': ' || SQLERRM")}`,
            '    END;'
        ].join('\n');
    }

    const liveCount = SECTIONS.reduce((count, [key]) => count + steps[key].length, 0);
    const out = [
        '-- ============================================================================',
        '-- Release Manager - Database Compare script',
        `-- Source: ${sourceName}    Target: ${targetName}    Schema: ${schema}`,
        `-- Built: ${new Date().toISOString()} from ${rows.length} row${rows.length === 1 ? '' : 's'} ticked on the page`,
        '--',
        `-- Makes ${targetName} match ${sourceName} for the rows ticked. Release Manager never runs this.`,
        '--',
        `-- HOW TO RUN (on ${targetName}, for example in the Supabase SQL editor):`,
        '--   1. PREVIEW: run it as it is. Every step runs, then EVERYTHING IS ROLLED BACK.',
        '--      The report comes back as the error message "PREVIEW ONLY: ...":',
        '--      that error is what undoes the changes.',
        '--   2. APPLY: if the report looks right, change  rm__apply boolean := false',
        '--      to true (a few lines below) and run it again. The changes are kept',
        '--      only if no step FAILED; the report is then shown as rows.',
        '--',
        '-- Report: OK = done. SKIPPED = already done. NOTE = left for you, does not',
        '-- block the apply. FAILED = undone, blocks the apply (the reason is shown).',
        '-- Nothing is ever removed: no table, view or column is dropped.'
    ];
    if (skipped) {
        out.push(`-- Skipped ${skipped} function/trigger item${skipped === 1 ? '' : 's'} (tick "Include functions and triggers" to add them).`);
    }
    out.push('-- ============================================================================');

    if (liveCount === 0) {
        out.push('', `-- Nothing to do: ${targetName} already has everything in the rows ticked, or only REVIEW notes are left.`);
    } else {
        const body = [
            'DECLARE',
            '    rm__apply  boolean := false;   -- false = PREVIEW (everything is rolled back), true = APPLY',
            '    rm__step   integer := 0;',
            '    rm__failed integer := 0;',
            '    rm__notes  integer := 0;',
            "    rm__report text    := '';",
            'BEGIN'
        ];
        let number = 0;
        let sectionNumber = 0;
        SECTIONS.forEach(([key, title]) => {
            if (!steps[key].length) return;
            sectionNumber++;
            body.push('', `    -- ── ${sectionNumber}. ${title} ──`);
            steps[key].forEach(step => {
                number++;
                body.push('', renderStep(step, number));
            });
        });
        body.push(
            '',
            '    -- ── Finish: keep the changes only when applying and nothing failed ──',
            '    IF NOT rm__apply THEN',
            "        RAISE EXCEPTION USING MESSAGE = format('PREVIEW ONLY: every step ran, then everything was rolled back (%s failed, %s notes). If the report looks right, set rm__apply to true at the top and run the script again.', rm__failed, rm__notes) || rm__report;",
            '    ELSIF rm__failed > 0 THEN',
            "        RAISE EXCEPTION USING MESSAGE = format('NOT APPLIED: %s step(s) failed, so everything was rolled back. See the report.', rm__failed) || rm__report;",
            '    END IF;',
            "    PERFORM set_config('rm.report', format('APPLIED: every step succeeded and the changes are kept (%s notes).', rm__notes) || rm__report, false);",
            'END'
        );
        out.push(
            '',
            `DO ${dollarQuote(`\n${body.join('\n')}\n`, 'rm_do')};`,
            '',
            '-- Shown only after an APPLY that succeeded: the report, one row per line.',
            "SELECT line AS report FROM unnest(string_to_array(current_setting('rm.report', true), E'\\n')) AS line;"
        );
    }

    if (review.length) {
        out.push('', '-- ════ REVIEW: not in the steps above, decide by hand (nothing here runs) ════', '', review.join('\n\n'));
    }
    if (manual.length) {
        out.push('', '-- ════ NOT SCRIPTED: add these by hand ════', '', ...manual);
    }
    if (onlyTarget.length) {
        out.push('', `-- ════ ONLY IN ${targetName} (left as they are, nothing removed) ════`, '', ...onlyTarget);
    }

    return {
        script: `${out.join('\n')}\n`,
        liveCount,
        reviewCount: review.length,
        onlyTargetCount: onlyTarget.length,
        skipped
    };
}

module.exports = { buildScript };