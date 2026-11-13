const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const { parseDataLua } = require('../data');
const source = fs.readFileSync(path.join(__dirname, '../bot.js'), 'utf8');
const original = fs.readFileSync(path.join(__dirname, '../../HuntLista/Data.lua'), 'utf8');
const originalCount = Object.keys(parseDataLua(original).players).length;

async function startBot() {
    const handlers = {};
    const bot = { remote: original, sha: '1', writes: 0, error: null };
    class Client {
        constructor() { this.user = { tag: 'test-bot' }; }
        once(name, handler) { handlers[name] = handler; }
        on(name, handler) { handlers[name] = handler; }
        async login() { handlers.ready(); }
    }
    class REST {
        setToken() { return this; }
        async put(_, body) { bot.commands = body.body; }
    }
    class Octokit {
        constructor() {
            this.rest = { repos: {
                async getContent() {
                    if (bot.error) throw bot.error;
                    return { data: { type: 'file', sha: bot.sha, encoding: 'base64',
                        content: Buffer.from(bot.remote).toString('base64') } };
                },
                async createOrUpdateFileContents(request) {
                    assert.equal(request.sha, bot.sha);
                    bot.remote = Buffer.from(request.content, 'base64').toString('utf8');
                    bot.sha = String(Number(bot.sha) + 1);
                    bot.writes++;
                },
            } };
        }
    }
    const mocks = {
        dotenv: { config() {} }, 'discord.js': { ...discord, Client, REST }, octokit: { Octokit }, './data': require('../data'),
    };
    vm.runInNewContext(source, {
        require(name) {
            // In particular, no local_data.json or other filesystem access is permitted.
            assert.ok(Object.hasOwn(mocks, name), 'Unexpected dependency: ' + name);
            return mocks[name];
        },
        process: { env: { DISCORD_TOKEN: 'test', GITHUB_TOKEN: 'test', CLIENT_ID: 'test', GUILD_ID: 'test' },
            exit() { throw new Error('Unexpected exit'); } },
        console: { log() {}, error() {} },
    });
    await new Promise(resolve => setImmediate(resolve));
    bot.command = async (sub, nick, reason = '', count = 1) => {
        const interaction = {
            deferred: false, replies: [], user: { username: 'test-user' }, commandName: 'hunt',
            isChatInputCommand: () => true,
            options: { getSubcommand: () => sub, getString: key => key === 'nick' ? nick : reason,
                getInteger: () => count },
            async deferReply() { this.deferred = true; },
            async editReply(reply) { for (const embed of reply.embeds || []) embed.toJSON(); this.replies.push(reply); },
            async reply(reply) { this.replies.push(reply); },
        };
        await handlers.interactionCreate(interaction);
        return interaction.replies.at(-1);
    };
    return bot;
}

test('actual command handler recovers the remote list without reading any local JSON', async () => {
    const bot = await startBot();
    assert.equal(bot.commands[0].name, 'hunt');
    const added = await bot.command('add', 'Audit Testplayer', 'Zażółć "gęślą"\\');
    assert.equal(added.embeds[0].data.title, 'Dodano na Hunt Listę');
    assert.equal(Object.keys(parseDataLua(bot.remote).players).length, originalCount + 1);
    const info = await bot.command('info', 'audit testplayer');
    assert.equal(info.embeds[0].data.fields[0].value, 'Zażółć "gęślą"\\');
    await bot.command('add', 'AUDIT TESTPLAYER', 'updated');
    assert.equal(Object.keys(parseDataLua(bot.remote).players).length, originalCount + 1);
    const removed = await bot.command('remove', 'audit testplayer');
    assert.match(removed.content, /GitHub OK/);
    assert.equal(Object.keys(parseDataLua(bot.remote).players).length, originalCount);
    const list = await bot.command('list');
    if (originalCount) assert.equal(list.embeds[0].data.title, `Hunt Lista (${originalCount})`);
    else assert.equal(list.content, 'Lista jest pusta.');
});

test('invalid nick and too-long reason do not write or report success', async () => {
    const bot = await startBot();
    for (const [nick, reason] of [[' ', ''], ['Bad\nNick', ''], ['Good Nick', 'x'.repeat(1025)]]) {
        const reply = await bot.command('add', nick, reason);
        assert.equal(reply.ephemeral, true);
        assert.equal(reply.embeds, undefined);
    }
    assert.equal(bot.writes, 0);
});

test('failed canonical read reports failure and cannot confirm a mutation', async () => {
    const bot = await startBot();
    bot.error = new Error('Offline');
    const reply = await bot.command('add', 'Good Nick');
    assert.match(reply.content, /Nie udało się potwierdzić/);
    assert.equal(reply.embeds, undefined);
    assert.equal(bot.writes, 0);
});

test('prototype-like player keys survive actual add and remove commands', async () => {
    const bot = await startBot();
    for (const name of ['__proto__', 'constructor']) {
        await bot.command('add', name);
        assert.equal(Object.hasOwn(parseDataLua(bot.remote).players, name), true);
        await bot.command('remove', name);
        assert.equal(Object.hasOwn(parseDataLua(bot.remote).players, name), false);
    }
    assert.equal(Object.keys(parseDataLua(bot.remote).players).length, originalCount);
});

test('adding a shorter full nick creates a separate player instead of overwriting a prefix match', async () => {
    const bot = await startBot();
    await bot.command('add', 'Audit Alpha', 'original');
    await bot.command('kill', 'Audit Alpha', '', 3);
    const before = parseDataLua(bot.remote).players['Audit Alpha'];
    await bot.command('add', 'Audit', 'new player');
    const after = parseDataLua(bot.remote).players;
    assert.deepEqual(after['Audit Alpha'], before);
    assert.equal(after.Audit.reason, 'new player');
    assert.equal(after.Audit.kills, '0');
});

test('remove, kill and killreset never mutate unique or ambiguous prefix matches', async () => {
    const bot = await startBot();
    await bot.command('add', 'Audit Alpha', 'first');
    await bot.command('kill', 'Audit Alpha', '', 3);
    for (const ambiguous of [false, true]) {
        if (ambiguous) await bot.command('add', 'Audit Beta', 'second');
        const before = bot.remote;
        const writes = bot.writes;
        for (const sub of ['remove', 'kill', 'killreset']) {
            const reply = await bot.command(sub, 'Audit');
            assert.match(reply.content, /pełnego nicku/);
            assert.equal(bot.writes, writes);
            assert.equal(bot.remote, before);
        }
    }
});

test('exact full names remain case-insensitive for every mutation and take priority over longer names', async () => {
    const bot = await startBot();
    await bot.command('add', 'Audit Alpha', 'keep');
    await bot.command('add', 'Audit', 'first');
    const longer = parseDataLua(bot.remote).players['Audit Alpha'];
    await bot.command('add', 'AUDIT', 'updated');
    await bot.command('kill', 'aUdIt', '', 4);
    assert.equal(parseDataLua(bot.remote).players.Audit.kills, '4');
    assert.equal(parseDataLua(bot.remote).players.Audit.reason, 'updated');
    await bot.command('killreset', 'audit');
    assert.equal(parseDataLua(bot.remote).players.Audit.kills, '0');
    await bot.command('remove', 'AUDIT');
    const after = parseDataLua(bot.remote).players;
    assert.equal(Object.hasOwn(after, 'Audit'), false);
    assert.deepEqual(after['Audit Alpha'], longer);
});
