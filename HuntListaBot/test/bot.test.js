const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const { generateLua, parseDataLua } = require('../data');
const source = fs.readFileSync(path.join(__dirname, '../bot.js'), 'utf8');
const original = fs.readFileSync(path.join(__dirname, '../../HuntLista/Data.lua'), 'utf8');
const originalCount = Object.keys(parseDataLua(original).players).length;

async function startBot(env = {}) {
    const handlers = {};
    const bot = { remote: original, sha: '1', reads: 0, writes: 0, logs: [] };
    class Client {
        constructor() { this.user = { tag: 'test-bot' }; }
        once(name, handler) { handlers[name] = handler; }
        on(name, handler) { handlers[name] = handler; }
        async login() { handlers.ready(); }
    }
    class REST {
        setToken() { return this; }
        async put(route, body) { bot.route = route; bot.commands = body.body; }
    }
    class Octokit {
        constructor() {
            this.rest = { repos: {
                async getContent() {
                    bot.reads++;
                    if (bot.error) throw bot.error;
                    return { data: { type: 'file', sha: bot.sha, encoding: 'base64',
                        content: Buffer.from(bot.remote).toString('base64') } };
                },
                async createOrUpdateFileContents(request) {
                    if (bot.writeError) throw bot.writeError;
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
        process: {
            env: { DISCORD_TOKEN: 'test', GITHUB_TOKEN: 'test', CLIENT_ID: 'test-client', GUILD_ID: 'test-guild', ...env },
            exit(code) { throw new Error(bot.logs.at(-1)[0] + ' Exit ' + code); },
        },
        console: { log() {}, error(...args) { bot.logs.push(args); } },
    });
    await new Promise(resolve => setImmediate(resolve));
    bot.command = async (sub, nick, reason = '', count = 1, overrides = {}) => {
        const interaction = {
            deferred: false, replies: [], user: { username: 'test-user' }, commandName: 'hunt', guildId: 'test-guild',
            member: { roles: { cache: new discord.Collection() } },
            memberPermissions: new discord.PermissionsBitField(discord.PermissionFlagsBits.Administrator),
            isChatInputCommand: () => true,
            options: { getSubcommand: () => sub, getString: key => key === 'nick' ? nick : reason,
                getInteger: key => key === 'ile' ? count : overrides.page ?? null },
            async deferReply() {
                if (bot.deferError) throw bot.deferError;
                this.deferred = true;
            },
            async editReply(reply) { this.recordReply(reply); },
            async reply(reply) { this.recordReply(reply); },
            recordReply(reply) {
                bot.failResponse?.(reply);
                for (const embed of reply.embeds || []) embed.toJSON();
                assert.ok((reply.embeds || []).reduce((total, embed) => total + embed.length, 0) <= 6000);
                this.replies.push(reply);
            },
            ...overrides,
        };
        bot.lastInteraction = interaction;
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
        assert.equal(reply.flags, discord.MessageFlags.Ephemeral);
        assert.equal(reply.embeds, undefined);
    }
    assert.equal(bot.writes, 0);
});

test('failed canonical read reports failure and cannot confirm a mutation', async () => {
    const bot = await startBot();
    bot.error = new Error('Offline');
    const reply = await bot.command('add', 'Good Nick');
    assert.match(reply.content, /Nie udało się potwierdzić/);
    assert.equal(reply.embeds.length, 0);
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

test('requires a configured guild and registers page options only on guild commands', async () => {
    await assert.rejects(startBot({ GUILD_ID: '' }), /GUILD_ID.*Exit 1/);
    const bot = await startBot({ GUILD_ID: ' test-guild ' });
    assert.equal(bot.route, discord.Routes.applicationGuildCommands('test-client', 'test-guild'));
    assert.equal(bot.commands[0].default_member_permissions, undefined);
    for (const name of ['list', 'kills']) {
        const [page] = bot.commands[0].options.find(sub => sub.name === name).options;
        assert.equal(page.name, 'strona');
        assert.equal(page.type, discord.ApplicationCommandOptionType.Integer);
        assert.equal(page.min_value, 1);
        assert.equal(Boolean(page.required), false);
    }
});

test('all Hunt Lista commands deny other guilds, DMs, and interactions without membership', async () => {
    const bot = await startBot({ CONTRIBUTOR_ROLE_IDS: '111', MODERATOR_ROLE_IDS: '222' });
    for (const context of [{ guildId: 'different' }, { guildId: null }, { member: null }]) {
        for (const sub of ['list', 'info', 'kills', 'add', 'kill', 'remove', 'killreset']) {
            const reply = await bot.command(sub, 'Audit Player', '', 1, context);
            assert.equal(reply.flags, discord.MessageFlags.Ephemeral);
            assert.match(reply.content, /skonfigurowanego serwera/);
            assert.equal(bot.lastInteraction.deferred, false);
        }
    }
    assert.equal(bot.reads, 0);
    assert.equal(bot.writes, 0);
});

test('guild members can read, add and kill without roles but cannot remove or reset by default', async () => {
    const members = [
        {
            member: { roles: { cache: new discord.Collection() } },
            memberPermissions: new discord.PermissionsBitField(),
        },
        { member: { roles: [] }, memberPermissions: null },
    ];
    for (const member of members) {
        const bot = await startBot();
        const added = await bot.command('add', 'Audit Player', 'reason', 1, member);
        assert.equal(added.embeds[0].data.title, 'Dodano na Hunt Listę');
        const kill = await bot.command('kill', 'Audit Player', '', 2, member);
        assert.equal(kill.embeds[0].data.title, 'Zabójstwo zapisane');
        assert.equal(parseDataLua(bot.remote).players['Audit Player'].kills, '2');
        const info = await bot.command('info', 'Audit Player', '', 1, member);
        assert.match(info.embeds[0].data.title, /Audit Player/);
        const list = await bot.command('list', null, '', 1, member);
        assert.match(list.embeds[0].data.description, /Audit Player/);
        const kills = await bot.command('kills', null, '', 1, member);
        assert.match(kills.embeds[0].data.description, /Audit Player/);

        const reads = bot.reads;
        const before = bot.remote;
        for (const sub of ['remove', 'killreset']) {
            const reply = await bot.command(sub, 'Audit Player', '', 1, member);
            assert.equal(reply.flags, discord.MessageFlags.Ephemeral);
            assert.match(reply.content, /Administrator/);
            assert.equal(bot.lastInteraction.deferred, false);
        }
        assert.equal(bot.reads, reads);
        assert.equal(bot.writes, 2);
        assert.equal(bot.remote, before);
    }
});

test('only administrators and configured moderators can remove or reset, regardless of legacy contributor roles', async () => {
    const bot = await startBot({ CONTRIBUTOR_ROLE_IDS: ' 111, 112, ', MODERATOR_ROLE_IDS: '221, 222' });
    const noPermissions = new discord.PermissionsBitField();
    const contexts = [
        {
            member: { roles: { cache: new discord.Collection([['112', { id: '112' }]]) } },
            memberPermissions: noPermissions,
        },
        {
            member: { roles: ['333'] },
            memberPermissions: new discord.PermissionsBitField(discord.PermissionFlagsBits.ManageGuild),
        },
    ];
    for (const member of contexts) {
        const added = await bot.command('add', 'Audit Player', '', 1, member);
        assert.equal(added.embeds[0].data.title, 'Dodano na Hunt Listę');
        const kill = await bot.command('kill', 'Audit Player', '', 2, member);
        assert.equal(kill.embeds[0].data.title, 'Zabójstwo zapisane');

        const reads = bot.reads;
        const writes = bot.writes;
        const before = bot.remote;
        for (const sub of ['remove', 'killreset']) {
            const denied = await bot.command(sub, 'Audit Player', '', 1, member);
            assert.equal(denied.flags, discord.MessageFlags.Ephemeral);
            assert.match(denied.content, /roli moderatora/);
        }
        assert.equal(bot.reads, reads);
        assert.equal(bot.writes, writes);
        assert.equal(bot.remote, before);
    }

    const moderators = [
        { member: { roles: ['222'] }, memberPermissions: null },
        {
            member: { roles: { cache: new discord.Collection([['221', { id: '221' }]]) } },
            memberPermissions: noPermissions,
        },
        {
            member: { roles: [] },
            memberPermissions: new discord.PermissionsBitField(discord.PermissionFlagsBits.Administrator),
        },
    ];
    for (const moderator of moderators) {
        await bot.command('add', 'Audit Player', '', 1, moderator);
        await bot.command('kill', 'Audit Player', '', 1, moderator);
        const reset = await bot.command('killreset', 'Audit Player', '', 1, moderator);
        assert.match(reset.content, /Wyzerowano/);
        assert.equal(parseDataLua(bot.remote).players['Audit Player'].kills, '0');
        const remove = await bot.command('remove', 'Audit Player', '', 1, moderator);
        assert.match(remove.content, /Usunięto/);
    }
    assert.equal(bot.writes, 16);
});

test('list preserves full rows across exact embed limits and splits oversized Unicode text safely', async () => {
    const bot = await startBot();
    const line = (name, reason) => `• **${name}** — ${reason} _(dodał: —)_`;
    const alpha = 'a'.repeat(4096 - line('Alpha', '').length);
    const beta = 'b'.repeat(4095 - '• **Beta** — '.length) + '🔸' + 'c'.repeat(4500);
    bot.remote = generateLua({
        version: 'v'.repeat(3500), lastUpdate: 'today', updatedBy: 'manual',
        players: { Alpha: { reason: alpha }, Beta: { reason: beta }, Gamma: { reason: 'last' } },
    });

    const pages = [];
    for (let page = 1; page <= 4; page++) {
        const reply = await bot.command('list', null, '', 1, page === 1 ? {} : { page });
        const embed = reply.embeds[0];
        assert.equal(embed.data.title, 'Hunt Lista (3)');
        assert.match(embed.data.footer.text, new RegExp(`Strona ${page}/4 • /hunt list strona:<numer>$`));
        assert.ok(embed.data.description.length <= 4096);
        pages.push(embed.data.description);
        if (page === 1) assert.equal(embed.length, 6000);
    }
    assert.equal(pages[0], line('Alpha', alpha));
    assert.equal(pages[1].length, 4095);
    assert.match(pages[2], /^🔸/u);
    assert.equal(pages.slice(1).join(''), line('Beta', beta) + '\n' + line('Gamma', 'last'));
    const missing = await bot.command('list', null, '', 1, { page: 5 });
    assert.match(missing.content, /strony 5.*1 do 4.*strona:1/);
});

test('kills paginates every rank with continuous numbering and no 40-row cap', async () => {
    const bot = await startBot();
    const players = Object.fromEntries(Array.from({ length: 75 }, (_, index) => [
        `Player ${index + 1}`, { kills: String(75 - index), lastKillBy: 'Gracz'.repeat(20) },
    ]));
    bot.remote = generateLua({ version: '1', lastUpdate: 'today', updatedBy: 'manual', players });

    const first = (await bot.command('kills')).embeds[0];
    assert.equal(first.data.title, 'Ranking zabójstw (75)');
    const pageCount = Number(first.data.footer.text.match(/Strona 1\/(\d+)/)[1]);
    assert.ok(pageCount > 1);
    const descriptions = [first.data.description];
    for (let page = 2; page <= pageCount; page++) {
        const reply = await bot.command('kills', null, '', 1, { page });
        assert.match(reply.embeds[0].data.footer.text, new RegExp(`Strona ${page}/${pageCount} • /hunt kills strona:<numer>$`));
        descriptions.push(reply.embeds[0].data.description);
    }
    assert.deepEqual(descriptions.join('\n').split('\n'), Object.entries(players).map(([name, player], index) =>
        `**${index + 1}.** ${name} — **x${player.kills}** _(ostatni: ${player.lastKillBy})_`));
    const missing = await bot.command('kills', null, '', 1, { page: pageCount + 1 });
    assert.match(missing.content, /Nie ma strony.*\/hunt kills strona:1/);
});

test('empty lists retain their responses and give the valid page number', async () => {
    const bot = await startBot();
    bot.remote = generateLua({ version: '1', lastUpdate: 'today', updatedBy: 'manual', players: {} });
    assert.equal((await bot.command('list')).content, 'Lista jest pusta.');
    assert.match((await bot.command('kills')).content, /Brak zapisanych zabójstw/);
    for (const sub of ['list', 'kills']) {
        const reply = await bot.command(sub, null, '', 1, { page: 2 });
        assert.match(reply.content, /Nie ma strony 2. Dostępna jest strona 1./);
    }
});

test('read and write failures are reported separately from Discord failures before any write', async () => {
    const bot = await startBot();
    bot.error = new Error('GitHub read unavailable');
    assert.match((await bot.command('list')).content, /Nie udało się odczytać.*GitHuba/);
    bot.error = null;
    bot.writeError = new Error('GitHub write unavailable');
    assert.match((await bot.command('add', 'Audit Player')).content, /Nie udało się potwierdzić.*GitHubie/);
    const reads = bot.reads;
    bot.deferError = new Error('Discord unavailable');
    assert.match((await bot.command('add', 'Audit Player')).content, /odpowiedzi na Discordzie/);
    assert.equal(bot.reads, reads);
    assert.equal(bot.writes, 0);
});

test('a committed write remains confirmed when embed generation or response delivery fails', async () => {
    const bot = await startBot();
    const formatFailure = await bot.command('add', 'Audit Player', '', 1, { user: { username: 'u'.repeat(1025) } });
    assert.match(formatFailure.content, /Zapisano zmiany na GitHubie/);
    assert.equal(bot.writes, 1);

    bot.failResponse = reply => {
        if (reply.embeds?.length) throw new Error('Discord edit unavailable');
    };
    const deliveryFailure = await bot.command('kill', 'Audit Player');
    assert.match(deliveryFailure.content, /Zapisano zmiany na GitHubie/);
    assert.equal(bot.writes, 2);
    assert.equal(parseDataLua(bot.remote).players['Audit Player'].kills, '1');
});

test('an unavailable Discord fallback does not reject the interaction handler or repeat a committed mutation', async () => {
    const bot = await startBot();
    bot.failResponse = () => { throw new Error('Discord unavailable'); };
    assert.equal(await bot.command('add', 'Audit Player'), undefined);
    assert.equal(bot.writes, 1);
    assert.ok(Object.hasOwn(parseDataLua(bot.remote).players, 'Audit Player'));
    assert.equal(bot.logs.length, 2);
    assert.match(bot.logs[1][0], /Nie udało się wysłać komunikatu/);
});

test('Discord messages with player-controlled text suppress mentions', async () => {
    const bot = await startBot();
    await bot.command('add', '@everyone', '<@123456789>');
    const reply = await bot.command('remove', '@everyone');
    assert.match(reply.content, /@everyone/);
    assert.equal(reply.allowedMentions.parse.length, 0);
    assert.equal(reply.allowedMentions.repliedUser, false);
});
