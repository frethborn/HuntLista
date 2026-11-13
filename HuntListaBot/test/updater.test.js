const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { generateLua, parseDataLua } = require('../data');
const root = path.join(__dirname, '../..');

test('both standalone updater folders ship the same validated helper', () => {
    assert.equal(fs.readFileSync(path.join(root, 'auto-updater/HuntLista-Data.ps1'), 'utf8'),
        fs.readFileSync(path.join(root, 'updater/HuntLista-Data.ps1'), 'utf8'));
});

test('Windows PowerShell 5.1 validates Lua and preserves live data and backups on failures', {
    skip: process.platform !== 'win32' ? 'Windows updater requires Windows PowerShell 5.1' : false,
}, () => {
    const original = fs.readFileSync(path.join(root, 'HuntLista/Data.lua'), 'utf8');
    const sample = { version: 'test-v1', lastUpdate: 'now', updatedBy: 'test', players: {
        'Tollwütige Fledermaus': { reason: 'Zażółć 🏹 "quotes" \\ tail\\', kills: '3' },
    } };
    const valid = generateLua(sample);
    const literal = reason => `HuntLista_Data={version='v',lastUpdate='now',updatedBy='test',players={['Test']={reason=${reason}}}}; HuntLista_Lookup={};`;
    const cases = [];
    const add = (name, content, accepted) => {
        const entry = { name, content, accepted };
        if (accepted) {
            const parsed = parseDataLua(content);
            Object.assign(entry, { version: parsed.version, lastUpdate: parsed.lastUpdate, count: Object.keys(parsed.players).length });
        } else assert.throws(() => parseDataLua(content), name + ': bot parser must also reject');
        cases.push(entry);
    };
    add('current repository data', original, true);
    add('generated Unicode and escaping', valid, true);
    add('UTF-8 BOM', '\uFEFF' + valid, true);
    add('long comment and long string', '--[==[ignored {} function()]==]\n' + literal('[=[\r\nfirst\r\nsecond]=]'), true);
    add('decimal UTF-8 bytes', literal('"\\195\\188"'), true);
    add('escaped line ending', literal('"first\\\r\nsecond"'), true);
    add('all supported escaped control bytes', literal('"\\a\\b\\f\\n\\r\\t\\v\\0009\\127"'), true);
    add('quoted keys and case-sensitive nicknames', `HuntLista_Data={['version']='v',['lastUpdate']='now',['updatedBy']='test',['players']={['and']={},['And']={}}} HuntLista_Lookup={}`, true);
    add('valid empty list', `HuntLista_Data={version='v',lastUpdate='',updatedBy='',players={}} HuntLista_Lookup={}`, true);
    for (const [name, content] of [
        ['truncated file', 'HuntLista_Data = {'],
        ['extra executable statement', valid + '\nprint("not data")'],
        ['Lua expression', literal('(function() return "bad" end)()')],
        ['missing lookup', valid.replace('HuntLista_Lookup = {}', '')],
        ['nonempty lookup', valid.replace('HuntLista_Lookup = {}', 'HuntLista_Lookup = { x = "bad" }')],
        ['duplicate root key', valid.replace('players = {', 'players = {}, players = {')],
        ['unknown root key', valid.replace('players = {', 'extra = "bad", players = {')],
        ['duplicate decoded key', `HuntLista_Data={version='v',lastUpdate='',updatedBy='',players={['A']={},['\\065']={}}} HuntLista_Lookup={}`],
        ['unknown player field', literal('"ok"').replace('reason=', 'unexpected=')],
        ['table as reason', literal('{}')],
        ['number as reason', literal('42')],
        ['boolean as reason', literal('true')],
        ['invalid escaped UTF-8', literal('"\\255"')],
        ['byte escape out of range', literal('"\\999"')],
        ['literal newline in short string', literal('"first\nsecond"')],
        ['anonymous table value', literal('"ok"').replace("['Test']=", '')],
        ['reserved identifier', literal('"ok"').replace("['Test']", 'and')],
        ['empty player name', literal('"ok"').replace("['Test']", "['  ']")],
        ['unterminated long comment', valid + '\n--[=[ missing close'],
        ['oversized payload', ' '.repeat(1024 * 1024 + 1)],
    ]) add(name, content, false);
    // Generated strings must remain safe and accepted by both implementations.
    for (const payload of ['" .. os.execute("bad") .. "', '\\", exploit = function() end, --', '__proto__', '\\123', 'x\r\ny\0z']) {
        add('generated payload ' + cases.length, generateLua({ version: payload, lastUpdate: payload, updatedBy: payload,
            players: { [payload]: { reason: payload, addedBy: payload, addedAt: payload, note: payload } } }), true);
    }

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huntlista-updater-test-'));
    try {
        fs.writeFileSync(path.join(directory, 'cases.json'), JSON.stringify(cases), 'utf8');
        fs.writeFileSync(path.join(directory, 'valid.lua'), valid, 'utf8');
        const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.join(root, 'updater/test/Test-HuntListaData.ps1'), '-FixtureDirectory', directory, '-RepositoryRoot', root],
        { encoding: 'utf8', timeout: 60000, windowsHide: true });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /PASS: updater checks/);
        console.info(result.stdout.trim());

        // Run the unchanged CLI entry point in a separate process (it calls exit).
        for (const file of ['Update-HuntLista.ps1', 'HuntLista-Data.ps1']) {
            fs.copyFileSync(path.join(root, 'updater', file), path.join(directory, file));
        }
        fs.writeFileSync(path.join(directory, 'updater-config.txt'), '\uFEFF' + directory, 'utf8');
        const runCli = mode => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.join(root, 'updater/test/Invoke-UpdaterFixture.ps1'), '-FixtureDirectory', directory, '-Mode', mode],
        { encoding: 'utf8', timeout: 30000, windowsHide: true });
        const before = fs.readFileSync(path.join(directory, 'Data.lua'), 'utf8');
        const backup = fs.readFileSync(path.join(directory, 'Data.lua.bak'), 'utf8');
        const bad = runCli('invalid');
        assert.ifError(bad.error);
        assert.equal(bad.status, 1, bad.stdout + bad.stderr);
        assert.match(bad.stdout, /\[BLAD\]/);
        assert.equal(fs.readFileSync(path.join(directory, 'Data.lua'), 'utf8'), before);
        assert.equal(fs.readFileSync(path.join(directory, 'Data.lua.bak'), 'utf8'), backup);
        const good = runCli('valid');
        assert.ifError(good.error);
        assert.equal(good.status, 0, good.stdout + good.stderr);
        assert.match(good.stdout, /AKTUALIZACJA UDANA/);
        assert.equal(fs.readFileSync(path.join(directory, 'Data.lua'), 'utf8'), valid);
        assert.equal(fs.readFileSync(path.join(directory, 'Data.lua.bak'), 'utf8'), before);
    } finally {
        // Only this test's flat, freshly-created directory is removed; no recursive deletion.
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            assert.ok(entry.isFile(), 'Unexpected directory in isolated updater fixture');
            fs.unlinkSync(path.join(directory, entry.name));
        }
        fs.rmdirSync(directory);
    }
});
