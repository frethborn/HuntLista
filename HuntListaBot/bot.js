/**
 * Hunt Lista Discord Bot
 *
 * Komendy:
 *   /hunt add <nick> [powód]
 *   /hunt remove <nick>
 *   /hunt list
 *   /hunt info <nick>
 *   /hunt kill <nick> [ile]   — wspólny licznik zabójstw (+1)
 *   /hunt kills              — ranking zabójstw
 *   /hunt killreset <nick>   — zeruj licznik
 */

require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { Octokit } = require('octokit');
const { createDataStore, validateNick } = require('./data');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'frethborn';
const GITHUB_REPO = process.env.GITHUB_REPO || 'HuntLista';
const GITHUB_PATH = process.env.GITHUB_PATH || 'HuntLista/Data.lua';

const store = createDataStore(new Octokit({ auth: GITHUB_TOKEN }), {
    owner: GITHUB_OWNER, repo: GITHUB_REPO, path: GITHUB_PATH,
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('hunt')
        .setDescription('Zarządzanie Hunt Listą')
        .addSubcommand(sub => sub.setName('add').setDescription('Dodaj gracza na listę')
            .addStringOption(o => o.setName('nick').setDescription('Nick gracza').setRequired(true).setMaxLength(64))
            .addStringOption(o => o.setName('powod').setDescription('Powód / notatka').setRequired(false).setMaxLength(1024)))
        .addSubcommand(sub => sub.setName('remove').setDescription('Usuń gracza z listy')
            .addStringOption(o => o.setName('nick').setDescription('Nick gracza').setRequired(true).setMaxLength(64)))
        .addSubcommand(sub => sub.setName('list').setDescription('Pokaż całą listę'))
        .addSubcommand(sub => sub.setName('info').setDescription('Szczegóły gracza')
            .addStringOption(o => o.setName('nick').setDescription('Nick gracza').setRequired(true).setMaxLength(64)))
        .addSubcommand(sub => sub.setName('kill').setDescription('Dodaj zabójstwo (wspólny licznik gildii)')
            .addStringOption(o => o.setName('nick').setDescription('Nick z listy').setRequired(true).setMaxLength(64))
            .addIntegerOption(o => o.setName('ile').setDescription('Ile dodać (domyślnie 1)').setRequired(false).setMinValue(1).setMaxValue(50)))
        .addSubcommand(sub => sub.setName('kills').setDescription('Ranking zabójstw (wspólny)'))
        .addSubcommand(sub => sub.setName('killreset').setDescription('Wyzeruj wspólny licznik gracza')
            .addStringOption(o => o.setName('nick').setDescription('Nick z listy').setRequired(true).setMaxLength(64)))
].map(c => c.toJSON());

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        if (GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
            console.log('Komendy zarejestrowane (guild).');
        } else {
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
            console.log('Komendy zarejestrowane (global).');
        }
    } catch (e) { console.error('Błąd rejestracji komend:', e); }
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

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'hunt') return;

    const sub = interaction.options.getSubcommand();
    const user = interaction.user.username;
    try {
        const needsNick = sub !== 'list' && sub !== 'kills';
        const nick = needsNick ? validateNick(interaction.options.getString('nick')) : null;
        const reason = sub === 'add' ? interaction.options.getString('powod') || '' : '';
        if (reason.length > 1024) throw new Error('Powód może mieć najwyżej 1024 znaki.');
        await interaction.deferReply();

        if (sub === 'add') {
            const { data } = await store.update(data => {
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
            await interaction.editReply({ embeds: [embed] });
        }
        else if (sub === 'remove') {
            let found;
            const { changed, data } = await store.update(data => {
                found = findExactPlayer(data, nick);
                if (!found) return false;
                delete data.players[found];
            });
            await interaction.editReply({ content: changed
                ? `Usunięto **${found}** z listy. Wersja: \`${data.version}\` (GitHub OK)`
                : `Nie ma pełnego nicku **${nick}** na liście. Sprawdź /hunt list.` });
        }
        else if (sub === 'list') {
            const data = await store.read();
            const names = Object.keys(data.players).sort((a, b) => a.localeCompare(b));
            if (names.length === 0) { await interaction.editReply({ content: 'Lista jest pusta.' }); return; }
            let text = names.map(n => {
                const p = data.players[n];
                const k = getKills(p);
                const kill = k > 0 ? ` **x${k}**` : '';
                return `• **${n}**${kill}${p.reason ? ` — ${p.reason}` : ''} _(dodał: ${p.addedBy || '—'})_`;
            }).join('\n');
            if (text.length > 3900) text = text.slice(0, 3900) + '\n…';
            const embed = new EmbedBuilder().setColor(0xff4444).setTitle(`Hunt Lista (${names.length})`)
                .setDescription(text).setFooter({ text: `Wersja: ${data.version} • ${data.lastUpdate}` });
            await interaction.editReply({ embeds: [embed] });
        }
        else if (sub === 'info') {
            const data = await store.read();
            const found = findPlayer(data, nick);
            if (!found) { await interaction.editReply({ content: `Nie ma **${nick}** na liście.` }); return; }
            const p = data.players[found];
            const embed = new EmbedBuilder().setColor(0xff4444).setTitle(found.slice(0, 256))
                .addFields(
                    { name: 'Powód', value: (p.reason || '—').slice(0, 1024), inline: false },
                    { name: 'Dodał', value: (p.addedBy || '—').slice(0, 1024), inline: true },
                    { name: 'Data', value: (p.addedAt || '—').slice(0, 1024), inline: true },
                    { name: 'Notatka', value: (p.note || '—').slice(0, 1024), inline: false },
                    { name: 'Zabójstwa (gildia)', value: String(getKills(p)), inline: true },
                    { name: 'Ostatni kill', value: p.lastKillBy ? `${p.lastKillBy} (${p.lastKillAt || '?'})` : '—', inline: true },
                );
            await interaction.editReply({ embeds: [embed] });
        }
        else if (sub === 'kill') {
            const ile = interaction.options.getInteger('ile') || 1;
            let found;
            let newCount = 0;
            const { changed, data } = await store.update(data => {
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
                await interaction.editReply({ content: `Nie ma pełnego nicku **${nick}** na liście. Sprawdź /hunt list lub dodaj gracza przez /hunt add.` });
                return;
            }
            const embed = new EmbedBuilder().setColor(0x44ff88).setTitle('Zabójstwo zapisane')
                .addFields(
                    { name: 'Nick', value: found, inline: true },
                    { name: 'Dodał', value: user, inline: true },
                    { name: 'Licznik', value: `**x${newCount}** (+${ile})`, inline: true },
                    { name: 'Wersja danych', value: data.version, inline: true },
                ).setFooter({ text: 'GitHub OK – odpalcie Auto Updater / zaktualizujcie Data.lua' });
            await interaction.editReply({ embeds: [embed] });
        }
        else if (sub === 'kills') {
            const data = await store.read();
            const rows = Object.keys(data.players).map(n => ({
                name: n,
                kills: getKills(data.players[n]),
                lastBy: data.players[n].lastKillBy || '',
            })).filter(r => r.kills > 0);
            rows.sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));
            if (rows.length === 0) {
                await interaction.editReply({ content: 'Brak zapisanych zabójstw. Użyj `/hunt kill <nick>`.' });
                return;
            }
            let text = rows.slice(0, 40).map((r, i) =>
                `**${i + 1}.** ${r.name} — **x${r.kills}**${r.lastBy ? ` _(ostatni: ${r.lastBy})_` : ''}`
            ).join('\n');
            const embed = new EmbedBuilder().setColor(0x44ff88).setTitle(`Ranking zabójstw (${rows.length})`)
                .setDescription(text).setFooter({ text: `Wersja: ${data.version}` });
            await interaction.editReply({ embeds: [embed] });
        }
        else if (sub === 'killreset') {
            let found;
            const { changed, data } = await store.update(data => {
                found = findExactPlayer(data, nick);
                if (!found) return false;
                data.players[found].kills = '0';
                data.players[found].lastKillBy = '';
                data.players[found].lastKillAt = '';
            });
            await interaction.editReply({ content: changed
                ? `Wyzerowano licznik **${found}**. Wersja: \`${data.version}\``
                : `Nie ma pełnego nicku **${nick}** na liście. Sprawdź /hunt list.` });
        }
    } catch (error) {
        console.error('Błąd komendy hunt:', error.message);
        const content = interaction.deferred
            ? 'Nie udało się potwierdzić operacji na GitHubie. Sprawdź /hunt list przed ponowieniem; przy konflikcie wersji ponów komendę.'
            : error.message;
        if (interaction.deferred) await interaction.editReply({ content });
        else await interaction.reply({ content, ephemeral: true });
    }
});

if (!DISCORD_TOKEN || !GITHUB_TOKEN) {
    console.error('Brak DISCORD_TOKEN lub GITHUB_TOKEN w .env');
    process.exit(1);
}

registerCommands().then(() => {
    client.login(DISCORD_TOKEN);
});
