const luaparse = require('luaparse');
const { TextDecoder } = require('node:util');
const { createHash } = require('node:crypto');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_FILE = 8 * 1024 * 1024;

function fields(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== allowed.length || allowed.some(k => !Object.hasOwn(value, k))) {
        throw new Error('Niepoprawna struktura synchronizacji.');
    }
}
function map(value, limit) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > limit) {
        throw new Error('Niepoprawna lub zbyt duża tabela synchronizacji.');
    }
}
function validGUID(value) {
    return typeof value === 'string' && value.length <= 128 && /^Player-[A-Za-z0-9-]+$/.test(value);
}
function validName(value) {
    return typeof value === 'string' && value.trim() === value && value.length > 0
        && Buffer.byteLength(value, 'utf8') <= 128 && !/[\x00-\x1f\x7f|]/.test(value);
}
function validateRecord(record) {
    fields(record, ['playerGUID', 'stream', 'victim', 'count', 'lastAt']);
    if (!validGUID(record.playerGUID) || typeof record.stream !== 'string'
        || !/^[A-Za-z0-9:-]{1,160}$/.test(record.stream) || !validName(record.victim)
        || !Number.isInteger(record.count) || record.count < 1 || record.count > 1e9
        || !Number.isSafeInteger(record.lastAt) || record.lastAt < 1 || record.lastAt > 8640000000000) {
        throw new Error('Niepoprawny wpis synchronizacji.');
    }
    return record;
}

function parseSavedVariables(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE) throw new Error('Zbyt duży plik SavedVariables.');
    const text = utf8.decode(bytes).replace(/^\uFEFF/, '');
    const ast = luaparse.parse(Buffer.from(text, 'utf8').toString('latin1'), {
        luaVersion: '5.1', encodingMode: 'pseudo-latin1', comments: false,
    });
    let sync;
    const assignments = new Set();
    let nodes = 0;
    function literal(node, depth = 0) {
        if (++nodes > 250000 || depth > 5) throw new Error('Zbyt złożone SavedVariables.');
        if (node.type === 'StringLiteral') {
            const raw = node.raw.startsWith('[') ? node.value.replace(/\r\n|\n\r|\r/g, '\n') : node.value;
            return utf8.decode(Buffer.from(raw, 'latin1'));
        }
        if (node.type === 'NumericLiteral' && Number.isSafeInteger(node.value)) return node.value;
        if (node.type !== 'TableConstructorExpression') throw new Error('SavedVariables nie są danymi.');
        const result = Object.create(null);
        for (const field of node.fields) {
            let key;
            if (field.type === 'TableKeyString') key = field.key.name;
            else if (field.type === 'TableKey' && field.key.type === 'StringLiteral') key = literal(field.key, depth);
            else throw new Error('Niepoprawny klucz SavedVariables.');
            if (Object.hasOwn(result, key)) throw new Error('Powtórzony klucz SavedVariables.');
            result[key] = literal(field.value, depth + 1);
        }
        return result;
    }
    for (const statement of ast.body) {
        if (statement.type !== 'AssignmentStatement' || statement.variables.length !== 1
            || statement.variables[0].type !== 'Identifier' || statement.init.length !== 1) {
            throw new Error('Nieoczekiwany kod w SavedVariables.');
        }
        const name = statement.variables[0].name;
        if (!['HuntListaDB', 'HuntListaSync'].includes(name) || assignments.has(name)) throw new Error('Nieoczekiwane przypisanie.');
        assignments.add(name);
        // HuntListaDB contains settings/local counters, never imported or executed.
        if (name === 'HuntListaSync') sync = literal(statement.init[0]);
    }
    if (!sync) return [];
    fields(sync, ['version', 'characters']);
    if (sync.version !== 1) throw new Error('Nieobsługiwana wersja synchronizacji.');
    map(sync.characters, 64);
    const records = [];
    for (const [playerGUID, character] of Object.entries(sync.characters)) {
        if (!validGUID(playerGUID)) throw new Error('Niepoprawny GUID postaci.');
        fields(character, ['stream', 'counts']);
        if (typeof character.stream !== 'string' || !/^[A-Za-z0-9:-]{1,160}$/.test(character.stream)) throw new Error('Niepoprawny strumień.');
        map(character.counts, 256);
        for (const [victim, counts] of Object.entries(character.counts)) {
            fields(counts, ['count', 'lastAt']);
            records.push(validateRecord({ playerGUID, stream: character.stream, victim, ...counts }));
        }
    }
    return records.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function importRanking(store, reporter, records) {
    if (!Array.isArray(records) || !records.length || records.length > 50) throw new Error('Pakiet musi mieć 1–50 wpisów.');
    const keys = new Set();
    for (const record of records) {
        validateRecord(record);
        if (!Object.hasOwn(reporter.characters, record.playerGUID)) throw new Error('Postać nie jest przypisana do tego klucza.');
        const key = JSON.stringify([record.playerGUID, record.stream, record.victim]);
        if (keys.has(key)) throw new Error('Powtórzony wpis w pakiecie.');
        keys.add(key);
    }
    let added = 0, ignored = 0, stale = 0;
    const result = await store.update((data, ledger) => {
        let changed = false;
        for (const record of records) {
            const key = createHash('sha256').update(JSON.stringify([record.playerGUID, record.stream, record.victim])).digest('hex');
            const previous = ledger[key] || 0;
            if (record.count < previous) { stale++; continue; } // A restored/old snapshot needs attention.
            if (record.count === previous) continue; // Retries and cloned files are no-ops.
            const delta = record.count - previous;
            const matches = Object.keys(data.players).filter(name => name.toLowerCase() === record.victim.toLowerCase());
            if (matches.length === 1) {
                const player = data.players[matches[0]];
                const current = Number(player.kills || '0');
                if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(current + delta)) {
                    throw new Error('Niepoprawny licznik rankingu; import zablokowany.');
                }
                player.kills = String(current + delta);
                const at = new Date(record.lastAt * 1000).toISOString().slice(0, 19).replace('T', ' ');
                const comparable = player.lastKillAt?.length === 16 ? at.slice(0, 16) : at;
                if (!player.lastKillAt || comparable > player.lastKillAt) {
                    player.lastKillBy = reporter.characters[record.playerGUID];
                    player.lastKillAt = at;
                }
                added += delta;
            } else {
                // Consume removed/ambiguous entries so re-adding a name cannot replay old kills.
                ignored += delta;
            }
            ledger[key] = record.count;
            changed = true;
        }
        return changed;
    });
    return { ok: true, added, ignored, stale, version: result.data.version };
}

module.exports = { parseSavedVariables, importRanking, validateRecord, validGUID, validName, MAX_FILE };
