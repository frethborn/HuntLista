const luaparse = require('luaparse');
const { TextDecoder } = require('node:util');
const { readLedger, writeLedger } = require('./sync-ledger');

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const metadata = ['version', 'lastUpdate', 'updatedBy'];
const playerFields = ['reason', 'addedBy', 'addedAt', 'note', 'kills', 'lastKillBy', 'lastKillAt'];

function luaString(value) {
    if (typeof value !== 'string') throw new Error('Oczekiwano tekstu w danych listy.');
    return '"' + value.replace(/["\\\x00-\x1f\x7f]/g,
        char => '\\' + char.charCodeAt(0).toString().padStart(3, '0')) + '"';
}

function validateNick(nick) {
    if (typeof nick !== 'string' || !nick.trim() || nick.length > 64 || /[\x00-\x1f\x7f]/.test(nick)) {
        throw new Error('Nick musi mieć od 1 do 64 znaków, bez znaków sterujących.');
    }
    return nick.trim();
}

function checkFields(value, allowed, required = allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !allowed.includes(key))
        || required.some(key => !Object.hasOwn(value, key))) {
        throw new Error('Niepoprawna struktura Data.lua.');
    }
}

function validateData(data) {
    checkFields(data, [...metadata, 'players']);
    for (const key of metadata) luaString(data[key]);
    if (!data.players || typeof data.players !== 'object' || Array.isArray(data.players)) {
        throw new Error('Brak tabeli graczy w Data.lua.');
    }
    for (const [name, player] of Object.entries(data.players)) {
        if (!name.trim()) throw new Error('Pusty nick w Data.lua.');
        checkFields(player, playerFields, []);
        for (const value of Object.values(player)) luaString(value);
    }
    return data;
}

function parseDataLua(content) {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 1024 * 1024) {
        throw new Error('Niepoprawny lub zbyt duży Data.lua.');
    }
    const ast = luaparse.parse(Buffer.from(content.replace(/^\uFEFF/, ''), 'utf8').toString('latin1'), {
        luaVersion: '5.1', encodingMode: 'pseudo-latin1', comments: false,
    });
    function literal(node, depth = 0) {
        if (node.type === 'StringLiteral') {
            const bytes = node.raw.startsWith('[') ? node.value.replace(/\r\n|\n\r|\r/g, '\n') : node.value;
            return utf8.decode(Buffer.from(bytes, 'latin1'));
        }
        if (node.type !== 'TableConstructorExpression' || depth > 2) {
            throw new Error('Data.lua może zawierać wyłącznie tabele i tekst.');
        }
        const value = Object.create(null);
        for (const field of node.fields) {
            let key;
            if (field.type === 'TableKeyString') key = field.key.name;
            else if (field.type === 'TableKey' && field.key.type === 'StringLiteral') key = literal(field.key);
            else throw new Error('Niepoprawny klucz w Data.lua.');
            if (Object.hasOwn(value, key)) throw new Error('Powtórzony klucz w Data.lua.');
            value[key] = literal(field.value, depth + 1);
        }
        return value;
    }
    if (ast.body.length !== 2) throw new Error('Nieoczekiwane instrukcje w Data.lua.');
    const values = ast.body.map((statement, index) => {
        const name = index === 0 ? 'HuntLista_Data' : 'HuntLista_Lookup';
        if (statement.type !== 'AssignmentStatement' || statement.variables.length !== 1
            || statement.variables[0].type !== 'Identifier' || statement.variables[0].name !== name
            || statement.init.length !== 1) throw new Error('Niepoprawne przypisanie w Data.lua.');
        return literal(statement.init[0]);
    });
    checkFields(values[1], []);
    return validateData(values[0]);
}

function generateLua(data) {
    validateData(data);
    let lua = `-- ============================================================
-- Hunt Lista - Dane (aktualizowane przez bota z Discorda / GitHub)
-- Nie edytuj ręcznie tego pliku jeśli używasz automatycznej aktualizacji.
-- ============================================================

HuntLista_Data = {
`;
    for (const key of metadata) lua += `    ${key} = ${luaString(data[key])},\n`;
    lua += '\n    players = {\n';
    for (const name of Object.keys(data.players).sort((a, b) => a.localeCompare(b))) {
        const p = data.players[name];
        // domyslne pola kill
        if (p.kills === undefined) p.kills = '0';
        if (p.lastKillBy === undefined) p.lastKillBy = '';
        if (p.lastKillAt === undefined) p.lastKillAt = '';
        lua += `        [${luaString(name)}] = {\n`;
        for (const key of playerFields) lua += `            ${key} = ${luaString(p[key] ?? '')},\n`;
        lua += '        },\n';
    }
    lua += '    }\n}\n\nHuntLista_Lookup = {}\n';
    parseDataLua(lua);
    return lua;
}

function bumpVersion(data) {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const previous = data.version.split('.');
    const number = previous[0] === date ? (parseInt(previous[1], 10) || 0) + 1 : 1;
    data.version = `${date}.${number}`;
    data.lastUpdate = now.toISOString().slice(0, 16).replace('T', ' ');
    data.updatedBy = 'DiscordBot';
}

function createDataStore(octokit, repository) {
    let pending = Promise.resolve();
    async function readSnapshot() {
        const { data: file } = await octokit.rest.repos.getContent(repository);
        if (file.type !== 'file' || file.encoding !== 'base64' || !file.sha || typeof file.content !== 'string') {
            throw new Error('Nie udało się odczytać pliku Data.lua z GitHuba.');
        }
        const encoded = file.content.replace(/\s/g, '');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded) throw new Error('Niepoprawna zawartość pliku z GitHuba.');
        const content = utf8.decode(bytes);
        return { data: parseDataLua(content), ledger: readLedger(content), sha: file.sha };
    }
    return {
        async read() { return (await readSnapshot()).data; },
        update(change) {
            const result = pending.then(async () => {
                const { data, ledger, sha } = await readSnapshot();
                if (change(data, ledger) === false) return { changed: false, data };
                bumpVersion(data);
                const output = writeLedger(ledger) + generateLua(data);
                parseDataLua(output); // Enforce the full file limit, including the ledger.
                const content = Buffer.from(output, 'utf8').toString('base64');
                await octokit.rest.repos.createOrUpdateFileContents({
                    ...repository, sha, content,
                    message: `Hunt Lista update ${data.version} (${Object.keys(data.players).length} graczy)`,
                });
                return { changed: true, data };
            });
            pending = result.catch(() => {});
            return result;
        },
    };
}

module.exports = { luaString, validateNick, parseDataLua, generateLua, createDataStore };
