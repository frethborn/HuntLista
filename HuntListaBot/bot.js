/**
 * Hunt Lista Discord Bot
 *
 * Komendy:
 *   /hunt add <nick> [powód]
 *   /hunt remove <nick>
 *   /hunt list [strona]
 *   /hunt info <nick>
 *   /hunt kill <nick> [ile]   — wspólny licznik zabójstw (+1)
 *   /hunt kills [strona]     — ranking zabójstw
 *   /hunt killreset <nick>   — zeruj licznik
 */

require('dotenv').config();
const {
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder,
    PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { Octokit } = require('octokit');
const { createDataStore, validateNick } = require('./data');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID?.trim();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'frethborn';
const GITHUB_REPO = process.env.GITHUB_REPO || 'HuntLista';
const GITHUB_PATH = process.env.GITHUB_PATH || 'HuntLista/Data.lua';

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !GITHUB_TOKEN) {
    console.error('Ustaw DISCORD_TOKEN, CLIENT_ID, GUILD_ID i GITHUB_TOKEN w .env.');
    process.exit(1);
}

function roleIds(value = '') {
    return value.split(',').map(id => id.trim()).filter(Boolean);
}

const moderatorRoles = roleIds(process.env.MODERATOR_ROLE_IDS);
const writeCommands = new Set(['add', 'kill', 'remove', 'killreset']);
const moderatorCommands = new Set(['remove', 'killreset']);

function mayModerate(interaction) {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;

    const roles = interaction.member.roles;
    return moderatorRoles.some(id =>
        id === interaction.guildId || (Array.isArray(roles) ? roles.includes(id) : roles?.cache?.has(id)));
}

const store = createDataStore(new Octokit({ auth: GITHUB_TOKEN }), {
    owner: GITHUB_OWNER, repo: GITHUB_REPO, path: GITHUB_PATH,
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function addPageOption(option) {
    return option.setName('strona').setDescription('Numer strony (domyślnie 1)').setMinValue(1);
}

const commands = [
    new SlashCommandBuilder()
        .setName('hunt')
        .setDescription('Zarządzanie Hunt Listą')
        .addSubcommand(sub => sub.setName('add').setDescription('Dodaj gracza na listę')
            .addStringOption(o => o.setName('nick').setDescription('Nick gracza').setRequired(true).setMaxLength(64))
            .addStringOption(o => o.setName('powod').setDescription('Powód / notatka').setRequired(false).setMaxLength(1024)))
        .addSubcommand(sub => sub.setName('remove').setDescription('Usuń gracza z listy')
            .addStringOption(o => o.setName('nick').setDescription('Nick gracza').setRequired(true).setMaxLength(64)))
        .addSubcommand(sub => sub.setName('list').setDescription('Pokaż listę')
            .addIntegerOption(addPageOption))
        .addSubcommand(sub => sub.setName('info').setDescription('Szczegóły gracza')
            .addStringOption(o => o.setName('nick').setDescription('Nick gracza').setRequired(true).setMaxLength(64)))
        .addSubcommand(sub => sub.setName('kill').setDescription('Dodaj zabójstwo (wspólny licznik gildii)')
            .addStringOption(o => o.setName('nick').setDescription('Nick z listy').setRequired(true).setMaxLength(64))
            .addIntegerOption(o => o.setName('ile').setDescription('Ile dodać (domyślnie 1)').setRequired(false).setMinValue(1).setMaxValue(50)))
        .addSubcommand(sub => sub.setName('kills').setDescription('Ranking zabójstw (wspólny)')
            .addIntegerOption(addPageOption))
        .addSubcommand(sub => sub.setName('killreset').setDescription('Wyzeruj wspólny licznik gracza')
            .addStringOption(o => o.setName('nick').setDescription('Nick z listy').setRequired(true).setMaxLength(64)))
].map(c => c.toJSON());

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('Komendy zarejestrowane (guild).');
    } catch (error) {
        console.error('Błąd rejestracji komend:', error.message);
    }
}

client.once('ready', () => {
    console.log(`Zalogowano jako ${client.user.tag}`);
});

function findExactPlayer(data, nick) {
    const lower = nick.toLowerCase();
    return Object.keys(data.players).find(key => key.toLowerCase() === lower);
}

function findPlayer(data, nick) {
    const exact = findExactPlayer(data, nick);
    if (exact) return exact;
    const lower = nick.toLowerCase();
    // fuzzy: pierwsze słowo (Forever)
    return Object.keys(data.players).find(key => {
        const k = key.toLowerCase();
        return k === lower || k.startsWith(lower + ' ');
    });
}

function getKills(p) {
    const n = parseInt(p && p.kills, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

const maxDescriptionLength = 4096;
const maxEmbedLength = 6000;
const maxFooterLength = 2048;

function sliceEnd(text, end) {
    const code = text.charCodeAt(end - 1);
    return end < text.length && code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

function shorten(text, limit) {
    return text.length <= limit ? text : text.slice(0, sliceEnd(text, limit - 1)) + '…';
}

function paginateRows(rows) {
    const pages = [];
    let page = '';
    for (const row of rows) {
        if (page && page.length + 1 + row.length > maxDescriptionLength) {
            pages.push(page);
            page = '';
        }
        if (row.length <= maxDescriptionLength) {
            page += page ? '\n' + row : row;
        } else {
            let offset = 0;
            while (row.length - offset > maxDescriptionLength) {
                const end = sliceEnd(row, offset + maxDescriptionLength);
                pages.push(row.slice(offset, end));
                offset = end;
            }
            page = row.slice(offset);
        }
    }
    if (page) pages.push(page);
    return pages;
}

function pageReply(sub, page, rows, title, metadata, color, emptyMessage) {
    const pages = paginateRows(rows);
    const count = Math.max(1, pages.length);
    if (!Number.isSafeInteger(page) || page < 1 || page > count) {
        const range = count === 1 ? 'Dostępna jest strona 1.' : `Dostępne strony od 1 do ${count}.`;
        return { content: `Nie ma strony ${page}. ${range} Użyj /hunt ${sub} strona:1.` };
    }
    if (!pages.length) return { content: emptyMessage };

    const description = pages[page - 1];
    const suffix = `Strona ${page}/${count} • /hunt ${sub} strona:<numer>`;
    const footerLimit = Math.min(maxFooterLength, maxEmbedLength - title.length - description.length);
    const footer = shorten(metadata, footerLimit - suffix.length - 3) + ' • ' + suffix;
    return { embeds: [new EmbedBuilder().setColor(color).setTitle(title)
        .setDescription(description).setFooter({ text: footer })] };
}

class DataStoreError extends Error {
    constructor(error) {
        super('Błąd operacji na Data.lua', { cause: error });
    }
}

async function dataOperation(operation) {
    try {
        return await operation();
    } catch (error) {
        throw new DataStoreError(error);
    }
}

async function respond(interaction, response) {
    const payload = { ...response, allowedMentions: { parse: [], repliedUser: false } };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function commandReply(sub, interaction, nick, reason, update) {
    const user = interaction.user.username;
    const read = () => dataOperation(() => store.read());

    if (sub === 'add') {
        const { data } = await update(data => {
            const key = findExactPlayer(data, nick) || nick;
            const prev = data.players[key] || {};
            data.players[key] = {
                reason,
                addedBy: user,
                addedAt: new Date().toISOString().slice(0, 10),
                note: prev.note || '',
                kills: prev.kills || '0',
                lastKillBy: prev.lastKillBy || '',
                lastKillAt: prev.lastKillAt || '',
            };
        });
        const embed = new EmbedBuilder().setColor(0xff4444).setTitle('Dodano na Hunt Listę')
            .addFields(
                { name: 'Nick', value: nick, inline: true },
                { name: 'Dodał', value: user, inline: true },
                { name: 'Powód', value: reason || '—', inline: false },
                { name: 'Wersja danych', value: data.version, inline: true },
            ).setFooter({ text: 'Wypchnięto na GitHub – zaktualizujcie addon w grze' });
        return { embeds: [embed] };
    }
    else if (sub === 'remove') {
        let found;
        const { changed, data } = await update(data => {
            found = findExactPlayer(data, nick);
            if (!found) return false;
            delete data.players[found];
        });
        return { content: changed
            ? `Usunięto **${found}** z listy. Wersja: \`${data.version}\` (GitHub OK)`
            : `Nie ma pełnego nicku **${nick}** na liście. Sprawdź /hunt list.` };
    }
    else if (sub === 'list') {
        const data = await read();
        const names = Object.keys(data.players).sort((a, b) => a.localeCompare(b));
        const rows = names.map(n => {
            const p = data.players[n];
            const k = getKills(p);
            const kill = k > 0 ? ` **x${k}**` : '';
            return `• **${n}**${kill}${p.reason ? ` — ${p.reason}` : ''} _(dodał: ${p.addedBy || '—'})_`;
        });
        const page = interaction.options.getInteger('strona') ?? 1;
        return pageReply(sub, page, rows, `Hunt Lista (${names.length})`,
            `Wersja: ${data.version} • ${data.lastUpdate}`, 0xff4444, 'Lista jest pusta.');
    }
    else if (sub === 'info') {
        const data = await read();
        const found = findPlayer(data, nick);
        if (!found) return { content: `Nie ma **${nick}** na liście.` };
        const p = data.players[found];
        const embed = new EmbedBuilder().setColor(0xff4444).setTitle(found.slice(0, 256))
            .addFields(
                { name: 'Powód', value: (p.reason || '—').slice(0, 1024), inline: false },
                { name: 'Dodał', value: (p.addedBy || '—').slice(0, 1024), inline: true },
                { name: 'Data', value: (p.addedAt || '—').slice(0, 1024), inline: true },
                { name: 'Notatka', value: (p.note || '—').slice(0, 1024), inline: false },
                { name: 'Zabójstwa (gildia)', value: String(getKills(p)), inline: true },
                { name: 'Ostatni kill', value: p.lastKillBy ? shorten(`${p.lastKillBy} (${p.lastKillAt || '?'})`, 1024) : '—', inline: true },
            );
        return { embeds: [embed] };
    }
    else if (sub === 'kill') {
        const ile = interaction.options.getInteger('ile') || 1;
        let found;
        let newCount = 0;
        const { changed, data } = await update(data => {
            found = findExactPlayer(data, nick);
            if (!found) return false;
            const p = data.players[found];
            const cur = getKills(p);
            newCount = cur + ile;
            p.kills = String(newCount);
            p.lastKillBy = user;
            p.lastKillAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
            if (!p.reason) p.reason = p.reason || '';
            if (!p.addedBy) p.addedBy = p.addedBy || '';
            if (!p.addedAt) p.addedAt = p.addedAt || '';
            if (!p.note) p.note = p.note || '';
        });
        if (!changed) {
            return { content: `Nie ma pełnego nicku **${nick}** na liście. Sprawdź /hunt list lub dodaj gracza przez /hunt add.` };
        }
        const embed = new EmbedBuilder().setColor(0x44ff88).setTitle('Zabójstwo zapisane')
            .addFields(
                { name: 'Nick', value: found, inline: true },
                { name: 'Dodał', value: user, inline: true },
                { name: 'Licznik', value: `**x${newCount}** (+${ile})`, inline: true },
                { name: 'Wersja danych', value: data.version, inline: true },
            ).setFooter({ text: 'GitHub OK – odpalcie Auto Updater / zaktualizujcie Data.lua' });
        return { embeds: [embed] };
    }
    else if (sub === 'kills') {
        const data = await read();
        const rows = Object.keys(data.players).map(n => ({
            name: n,
            kills: getKills(data.players[n]),
            lastBy: data.players[n].lastKillBy || '',
        })).filter(r => r.kills > 0);
        rows.sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));
        const lines = rows.map((r, i) =>
            `**${i + 1}.** ${r.name} — **x${r.kills}**${r.lastBy ? ` _(ostatni: ${r.lastBy})_` : ''}`
        );
        const page = interaction.options.getInteger('strona') ?? 1;
        return pageReply(sub, page, lines, `Ranking zabójstw (${rows.length})`,
            `Wersja: ${data.version}`, 0x44ff88, 'Brak zapisanych zabójstw. Użyj `/hunt kill <nick>`.');
    }
    else if (sub === 'killreset') {
        let found;
        const { changed, data } = await update(data => {
            found = findExactPlayer(data, nick);
            if (!found) return false;
            data.players[found].kills = '0';
            data.players[found].lastKillBy = '';
            data.players[found].lastKillAt = '';
        });
        return { content: changed
            ? `Wyzerowano licznik **${found}**. Wersja: \`${data.version}\``
            : `Nie ma pełnego nicku **${nick}** na liście. Sprawdź /hunt list.` };
    }
    return { content: 'Nieznana komenda Hunt Listy.' };
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'hunt') return;

    let sub;
    let saved = false;
    try {
        if (interaction.guildId !== GUILD_ID || !interaction.member) {
            await respond(interaction, { content: 'Komendy Hunt Listy są dostępne dla członków skonfigurowanego serwera.' });
            return;
        }
        sub = interaction.options.getSubcommand();
        if (moderatorCommands.has(sub) && !mayModerate(interaction)) {
            await respond(interaction, {
                content: 'Ta komenda wymaga uprawnienia Administrator lub skonfigurowanej roli moderatora Hunt Listy.',
            });
            return;
        }

        let nick;
        let reason;
        try {
            nick = sub !== 'list' && sub !== 'kills' ? validateNick(interaction.options.getString('nick')) : null;
            reason = sub === 'add' ? interaction.options.getString('powod') || '' : '';
            if (reason.length > 1024) throw new Error('Powód może mieć najwyżej 1024 znaki.');
        } catch (error) {
            await respond(interaction, { content: error.message });
            return;
        }

        await interaction.deferReply();
        const response = await commandReply(sub, interaction, nick, reason, async change => {
            const result = await dataOperation(() => store.update(change));
            saved = result.changed;
            return result;
        });
        await respond(interaction, response);
    } catch (error) {
        let content = saved
            ? 'Zapisano zmiany na GitHubie. Nie udało się wyświetlić szczegółów operacji.'
            : 'Nie udało się obsłużyć odpowiedzi na Discordzie.';
        if (error instanceof DataStoreError) {
            console.error('Błąd operacji na Data.lua:', error.cause?.message);
            content = writeCommands.has(sub)
                ? 'Nie udało się potwierdzić operacji na GitHubie. Sprawdź /hunt list przed ponowieniem.'
                : 'Nie udało się odczytać Hunt Listy z GitHuba.';
        } else {
            console.error('Błąd odpowiedzi na komendę hunt:', error.message);
        }
        try {
            await respond(interaction, { content, embeds: [] });
        } catch (replyError) {
            console.error('Nie udało się wysłać komunikatu na Discordzie:', replyError.message);
        }
    }
});

registerCommands().then(() => client.login(DISCORD_TOKEN)).catch(error => {
    console.error('Nie udało się uruchomić bota Discord:', error.message);
    process.exitCode = 1;
});
