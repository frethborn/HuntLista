const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runLua, lua, to_luastring, to_jsstring } = require('./lua');
const { luaString, createDataStore, parseDataLua, generateLua } = require('../data');
const { readLedger, writeLedger } = require('../sync-ledger');
const { parseSavedVariables, importRanking, MAX_FILE } = require('../ranking-sync');
const { createRankingServer, validateReporters } = require('../ranking-server');
const { createCompanion, validateConfig } = require('../ranking-companion');

const token = 'a'.repeat(43);
const guid = 'Player-1-ABC123';
const reporter = { id: 'alice', token, characters: { [guid]: 'Alice Archer' } };
const record = (overrides = {}) => ({ playerGUID: guid, stream: '1700000000:12:34', victim: 'Mega Enemy', count: 1, lastAt: 1700000000, ...overrides });
function saved(records = [record()]) {
    const characters = new Map();
    for (const r of records) {
        if (!characters.has(r.playerGUID)) characters.set(r.playerGUID, { stream: r.stream, counts: [] });
        characters.get(r.playerGUID).counts.push(`[${luaString(r.victim)}]={count=${r.count},lastAt=${r.lastAt}}`);
    }
    return Buffer.from(`HuntListaDB={kills={manual={count=900}},rankingSyncEnabled={}}\nHuntListaSync={version=1,characters={${[...characters].map(([g, c]) =>
        `[${luaString(g)}]={stream=${luaString(c.stream)},counts={${c.counts.join(',')}}}`).join(',')}}}`);
}
function github() {
    const remote = { sha: '1', writes: 0, loseResponse: false, conflict: false,
        content: generateLua({ version: 'v', lastUpdate: '', updatedBy: '', players: { 'Mega Enemy': { kills: '4' }, 'Other Enemy': {} } }) };
    remote.client = { rest: { repos: {
        async getContent() { return { data: { type: 'file', encoding: 'base64', sha: remote.sha, content: Buffer.from(remote.content).toString('base64') } }; },
        async createOrUpdateFileContents(request) {
            if (remote.conflict || request.sha !== remote.sha) throw Object.assign(new Error('Conflict'), { status: 409 });
            remote.content = Buffer.from(request.content, 'base64').toString('utf8');
            remote.sha = String(Number(remote.sha) + 1); remote.writes++;
            if (remote.loseResponse) { remote.loseResponse = false; throw new Error('Connection lost after commit'); }
        },
    } } };
    remote.store = createDataStore(remote.client, { owner: 'test', repo: 'test', path: 'Data.lua' });
    return remote;
}
const kills = remote => Number(parseDataLua(remote.content).players['Mega Enemy'].kills);

test('SavedVariables parser imports only the explicit journal, including Unicode and decimal escapes', () => {
    const bytes = saved([record(), record({ victim: 'Tollwütige Fledermaus', count: 2 })]);
    assert.equal(parseSavedVariables(bytes).length, 2);
    assert.equal(parseSavedVariables(Buffer.from(bytes.toString().replace('ü', '\\195\\188'))).find(r => r.count === 2).victim, 'Tollwütige Fledermaus');
    assert.deepEqual(parseSavedVariables(Buffer.from('HuntListaDB={kills={old={count=999}}}')), []);
    assert.deepEqual(parseSavedVariables(Buffer.concat([Buffer.from([239, 187, 191]), saved()])), [record()]);
    assert.equal(parseSavedVariables(saved([record({ victim: '__proto__' })]))[0].victim, '__proto__');
});

test('SavedVariables never execute Lua and reject corruption, duplicate fields, wrong schema and oversized files', () => {
    const original = saved().toString();
    for (const text of [original.slice(0, -4), original + '\nprint("execute")', original + '\nHuntListaSync={}',
        original.replace('version=1', 'version=2'), original.replace('version=1', 'version=1,version=1'),
        original.replace('count=1,', 'count=-1,'), original.replace('count=1,', 'count=1.5,'),
        original.replace('count=1,', 'count=1000000001,'), original.replace('count=1,', 'count=(function() return 1 end)(),'),
        original.replace('counts={', 'counts={unexpected=1,'), original.replace('Mega Enemy', '\\255'),
        original.replace(guid, 'Creature-1-123')]) assert.throws(() => parseSavedVariables(Buffer.from(text)));
    assert.throws(() => parseSavedVariables(Buffer.from([255])));
    assert.throws(() => parseSavedVariables(Buffer.alloc(MAX_FILE + 1)));
});

test('cumulative imports are idempotent across restarts, stale snapshots and ambiguous write outcomes', async () => {
    const remote = github();
    assert.equal((await importRanking(remote.store, reporter, [record({ count: 3 })])).added, 3);
    assert.equal(kills(remote), 7);
    const restarted = createDataStore(remote.client, { owner: 'test', repo: 'test', path: 'Data.lua' });
    assert.equal((await importRanking(restarted, reporter, [record({ count: 3 })])).added, 0);
    assert.equal((await importRanking(restarted, reporter, [record()])).stale, 1);
    assert.equal(remote.writes, 1);
    remote.loseResponse = true;
    await assert.rejects(importRanking(restarted, reporter, [record({ count: 5 })]));
    assert.equal(kills(remote), 9);
    assert.equal((await importRanking(restarted, reporter, [record({ count: 5 })])).added, 0);
    assert.equal(kills(remote), 9);
});

test('manual writes and resets preserve receipts, while unrelated edits and CAS conflicts are safe', async () => {
    const remote = github();
    await importRanking(remote.store, reporter, [record({ count: 2 })]);
    const ledger = readLedger(remote.content);
    await remote.store.update(data => { data.players['Mega Enemy'].kills = '0'; data.players.New = {}; });
    assert.deepEqual(readLedger(remote.content), ledger);
    await importRanking(remote.store, reporter, [record({ count: 2 })]);
    assert.equal(kills(remote), 0);
    remote.conflict = true;
    await assert.rejects(importRanking(remote.store, reporter, [record({ count: 3 })]));
    assert.equal(kills(remote), 0);
    remote.conflict = false;
    await importRanking(remote.store, reporter, [record({ count: 3 })]);
    assert.equal(kills(remote), 1);
    assert.ok(parseDataLua(remote.content).players.New);
});

test('parallel bot instances cannot lose or double-count an import', async () => {
    const remote = github();
    const second = createDataStore(remote.client, { owner: 'test', repo: 'test', path: 'Data.lua' });
    await Promise.allSettled([importRanking(remote.store, reporter, [record()]), importRanking(second, reporter, [record()])]);
    await importRanking(second, reporter, [record()]);
    assert.equal(kills(remote), 5);
    assert.equal(remote.writes, 1);
});

test('unknown and ambiguous names are consumed without prefix guesses or resurrection after re-adding', async () => {
    const remote = github();
    await remote.store.update(data => { data.players['Case Enemy'] = {}; data.players['case enemy'] = {}; });
    const rows = [record({ victim: 'Mega' }), record({ victim: 'Case Enemy' }), record({ victim: 'Removed Enemy' })];
    const result = await importRanking(remote.store, reporter, rows);
    assert.equal(result.added, 0); assert.equal(result.ignored, 3); assert.equal(kills(remote), 4);
    await remote.store.update(data => { data.players['Removed Enemy'] = {}; });
    await importRanking(remote.store, reporter, rows);
    assert.equal(parseDataLua(remote.content).players['Removed Enemy'].kills, '0');
});

test('reporter authorization, invalid counters and corrupt/full receipts fail without changing the ranking', async () => {
    const remote = github();
    await assert.rejects(importRanking(remote.store, reporter, [record({ playerGUID: 'Player-2-other' })]));
    await assert.rejects(importRanking(remote.store, reporter, [record(), record()]));
    assert.equal(remote.writes, 0);
    for (const prefix of ['-- HuntListaSyncLedger v2: {}\n', '-- HuntListaSyncLedger v1: nope\n',
        '-- HuntListaSyncLedger v1: {}\n-- HuntListaSyncLedger v1: {}\n']) {
        remote.content = prefix + generateLua(parseDataLua(remote.content));
        await assert.rejects(importRanking(remote.store, reporter, [record()]));
        assert.equal(remote.writes, 0);
    }
    const full = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [i.toString(16).padStart(64, '0'), 1]));
    remote.content = writeLedger(full) + generateLua(parseDataLua(remote.content));
    await assert.rejects(importRanking(remote.store, reporter, [record()]));
    assert.equal(remote.writes, 0);
});

async function server(t, remote = github()) {
    const service = createRankingServer(remote.store, { reporters: [reporter] });
    service.listen(0, '127.0.0.1'); await once(service, 'listening');
    t.after(() => new Promise(resolve => { service.closeAllConnections(); service.close(resolve); }));
    return { remote, endpoint: `http://127.0.0.1:${service.address().port}/v1/kills` };
}
function config(endpoint) { return { endpoint, token, savedVariables: 'unused', characters: [guid], intervalSeconds: 10 }; }
const delay = () => new Promise(resolve => setTimeout(resolve, 1100));

test('HTTP endpoint authenticates reporters, rejects other GUIDs and malformed/oversized requests', async t => {
    const { endpoint, remote } = await server(t);
    const send = (body, key = token, contentType = 'application/json') => fetch(endpoint, {
        method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': contentType }, body: JSON.stringify(body),
    });
    assert.equal((await send({ records: [record()] }, 'b'.repeat(43))).status, 401);
    assert.equal((await send({ records: [record()] }, token, 'text/plain')).status, 415);
    assert.equal((await send({ junk: 'x'.repeat(65536) })).status, 413);
    assert.equal((await send({ records: [record({ playerGUID: 'Player-2-other' })] })).status, 403);
    assert.equal(remote.writes, 0);
    await delay();
    assert.equal((await send({ records: [record({ count: -1 })] })).status, 400);
    await delay();
    assert.equal((await send({ records: [record()] })).status, 200);
    assert.equal((await send({ records: [record()] })).status, 429);
    assert.equal(kills(remote), 5);
});

test('companion reads real SavedVariables and retries a lost HTTP acknowledgment exactly once', async t => {
    const { endpoint, remote } = await server(t);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huntlista-sync-'));
    const file = path.join(directory, 'HuntLista.lua');
    t.after(async () => { await fs.unlink(file); await fs.rmdir(directory); });
    await fs.writeFile(file, saved());
    let lose = true, calls = 0;
    const companion = createCompanion({ ...config(endpoint), savedVariables: file }, {
        fetch: async (...args) => { calls++; const response = await fetch(...args); if (lose) { lose = false; await response.text(); throw new Error('Lost acknowledgment'); } return response; },
    });
    await assert.rejects(companion.sync());
    assert.equal(kills(remote), 5);
    await delay();
    assert.equal((await companion.sync()).added, 0);
    assert.equal((await companion.sync()).unchanged, true);
    assert.equal(calls, 2);
    await fs.writeFile(file, saved([record({ count: 2 })]));
    await delay();
    assert.equal((await companion.sync()).added, 1);
    assert.equal(kills(remote), 6);
    await fs.writeFile(file, saved().subarray(0, 25));
    await assert.rejects(companion.sync());
    assert.equal(kills(remote), 6);
});

test('companion rejects unsafe destinations and does not follow redirects or acknowledge failed responses', async () => {
    for (const endpoint of ['http://example.com/v1/kills', 'https://example.com/else', 'https://user:pass@example.com/v1/kills', 'https://example.com/v1/kills?key=secret']) {
        assert.throws(() => validateConfig(config(endpoint)));
    }
    assert.throws(() => validateReporters([{ ...reporter, token: 'short' }]));
    assert.throws(() => validateReporters([reporter, { ...reporter, id: 'second', token: 'b'.repeat(43) }]));
    let calls = 0;
    const companion = createCompanion(config('https://example.com/v1/kills'), { read: async () => saved(), fetch: async (_, options) => {
        calls++; assert.equal(options.redirect, 'error'); assert.ok(options.signal);
        return { ok: true, json: async () => ({ ok: false }) };
    } });
    await assert.rejects(companion.sync()); await assert.rejects(companion.sync());
    assert.equal(calls, 2);
});

test('old offline imports increase totals without replacing the last newer killer', async () => {
    const remote = github();
    await remote.store.update(data => { data.players['Mega Enemy'].lastKillAt = '2026-11-14 20:00'; data.players['Mega Enemy'].lastKillBy = 'Newer Killer'; });
    await importRanking(remote.store, reporter, [record()]);
    assert.equal(kills(remote), 5);
    assert.equal(parseDataLua(remote.content).players['Mega Enemy'].lastKillBy, 'Newer Killer');
});

test('the real Lua journal is readable by the companion and imported without a manual Discord command', async () => {
    const source = await fs.readFile(path.join(__dirname, '../../HuntLista/RankingSync.lua'), 'utf8');
    let exported;
    runLua(`
        HuntLista = {}
        HuntListaDB = {}
        strlower = string.lower
        strtrim = function(s) return (s:gsub('^%s+', ''):gsub('%s+$', '')) end
        UnitGUID = function() return ${luaString(guid)} end
        GetTime = function() return 100 end
        time = function() return 1700000000 end
        print = function() end
        ${source}
        HuntLista:SetRankingSyncEnabled(true)
        assert(HuntLista:QueueRankingKill('Mega Enemy'))
        assert(HuntLista:QueueRankingKill('Mega Enemy'))
        local function saved(value)
            if type(value) == 'string' then return string.format('%q', value) end
            if type(value) == 'number' then return tostring(value) end
            local fields = {}
            for k, v in pairs(value) do table.insert(fields, '[' .. saved(k) .. ']=' .. saved(v)) end
            return '{' .. table.concat(fields, ',') .. '}'
        end
        exported = 'HuntListaSync=' .. saved(HuntListaSync)
    `, state => {
        lua.lua_getglobal(state, to_luastring('exported'));
        exported = to_jsstring(lua.lua_tostring(state, -1));
    });
    const remote = github();
    const companion = createCompanion(config('https://example.com/v1/kills'), {
        read: async () => Buffer.from(exported),
        fetch: async (_, options) => ({ ok: true, json: () => importRanking(remote.store, reporter, JSON.parse(options.body).records) }),
    });
    assert.equal((await companion.sync()).added, 1);
    assert.equal(kills(remote), 5);
    assert.equal((await companion.sync()).unchanged, true);
});

test('a partially acknowledged multi-batch snapshot can be replayed without losing or doubling counts', async () => {
    const remote = github();
    const records = Array.from({ length: 51 }, (_, i) => record({ victim: 'Enemy ' + i }));
    await remote.store.update(data => { for (const r of records) data.players[r.victim] = {}; });
    let calls = 0;
    const companion = createCompanion(config('https://example.com/v1/kills'), {
        read: async () => saved(records),
        fetch: async (_, options) => {
            calls++;
            const result = await importRanking(remote.store, reporter, JSON.parse(options.body).records);
            if (calls === 2) throw new Error('Last acknowledgment lost');
            return { ok: true, json: async () => result };
        },
    });
    await assert.rejects(companion.sync());
    assert.equal((await companion.sync()).added, 0);
    for (const r of records) assert.equal(parseDataLua(remote.content).players[r.victim].kills, '1');
});

test('BOM, leading whitespace and CR line endings cannot hide import receipts', async () => {
    const remote = github();
    await importRanking(remote.store, reporter, [record({ count: 5 })]);
    remote.content = '\uFEFF  ' + remote.content.replace(/\n/g, '\r');
    await importRanking(remote.store, reporter, [record({ count: 5 })]);
    assert.equal(kills(remote), 9);
    assert.equal(remote.writes, 1);
    await remote.store.update(data => { data.players.New = {}; });
    await importRanking(remote.store, reporter, [record({ count: 6 })]);
    assert.equal(kills(remote), 10);
});

test('a rolled-back journal produces an explicit stale result instead of successful acknowledgment', async () => {
    const remote = github();
    await importRanking(remote.store, reporter, [record({ count: 5 })]);
    let calls = 0;
    const companion = createCompanion(config('https://example.com/v1/kills'), {
        read: async () => saved([record({ count: 3 })]),
        fetch: async (_, options) => { calls++; return { ok: true, json: () => importRanking(remote.store, reporter, JSON.parse(options.body).records) }; },
    });
    assert.equal((await companion.sync()).stale, 1);
    assert.equal((await companion.sync()).stale, 1);
    assert.equal(calls, 2);
    assert.equal(kills(remote), 9);
});

test('an older kill within the same minute cannot replace a newer killer or an imprecise legacy time', async () => {
    for (const existing of ['2026-11-14 20:00:55', '2026-11-14 20:00']) {
        const remote = github();
        await remote.store.update(data => { data.players['Mega Enemy'].lastKillAt = existing; data.players['Mega Enemy'].lastKillBy = 'Existing Killer'; });
        await importRanking(remote.store, reporter, [record({ lastAt: Date.parse('2026-11-14T20:00:05Z') / 1000 })]);
        assert.equal(parseDataLua(remote.content).players['Mega Enemy'].lastKillBy, 'Existing Killer');
        await importRanking(remote.store, reporter, [record({ count: 2, lastAt: Date.parse('2026-11-14T20:01:03Z') / 1000 })]);
        assert.equal(parseDataLua(remote.content).players['Mega Enemy'].lastKillBy, 'Alice Archer');
        assert.equal(parseDataLua(remote.content).players['Mega Enemy'].lastKillAt, '2026-11-14 20:01:03');
    }
});
