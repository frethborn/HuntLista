const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { runLua } = require('./lua');
const { luaString } = require('../data');
const addonPath = path.join(__dirname, '../../HuntLista');
const sources = Object.fromEntries(['Core.lua', 'RankingSync.lua', 'Kills.lua', 'KillDetection.lua', 'GuildKills.lua'].map(name =>
    [name, luaString(fs.readFileSync(path.join(addonPath, name), 'utf8'))]));

// Separate Lua environments model clients sharing only addon messages, never SavedVariables.
const setup = `
local sources = { ${Object.entries(sources).map(([name, code]) => `[${luaString(name)}] = ${code}`).join(',')} }
world = { now = 100, clients = {}, packets = {}, pending = {} }
function client(name, options)
    options = options or {}
    local c = { name = name, frames = {}, filters = {}, alerts = {}, logs = {}, sounds = 0,
        inGuild = true, targetAlive = true, targetExists = false,
        units = { player = { guid = options.guid or 'Player-1-' .. name:gsub('[^%w-]', '') }, pet = { guid = 'Pet-1-' .. name } } }
    local env = setmetatable({}, { __index = _G })
    env._G = env
    env.HuntListaDB = options.savedDB or {}
    env.HuntListaSync = options.savedSync
    env.HuntLista_Data = { version = 'test', players = {
        ['Mega Enemy'] = {}, ['Mega Rival'] = {}, ['Bad Guy'] = {}, ['Tollwütige Fledermaus'] = {},
        ['Case Conflict'] = {}, ['case conflict'] = {}, ['Mega Enemy-Slayer'] = {}
    }}
    env.HuntLista_Lookup = {}
    env.SlashCmdList = {}
    env.strlower = string.lower
    env.strtrim = function(s) return (s:gsub('^%s+', ''):gsub('%s+$', '')) end
    env.wipe = function(t) for k in pairs(t) do t[k] = nil end end
    env.GetTime = function() return world.now end
    env.time = function() return 1000 + world.now end
    env.IsInGuild = function() return c.inGuild end
    env.UnitExists = function(unit) return unit == 'target' and c.targetExists end
    env.UnitIsPlayer = function() return true end
    env.UnitName = function(unit) return unit == 'target' and 'Mega Enemy' or name:match('^%S+') end
    env.UnitIsDeadOrGhost = function() return not c.targetAlive end
    env.UnitAffectingCombat = function() return true end
    env.issecretvalue = function(value) return value ~= nil and value == c.secret end
    env.Constants = { CharacterNameSeparatorConsts = { CHARACTERNAME_SURNAME_SEPARATOR = ' ' } }
    env.UnitGUID = function(unit) return c.units[unit] and c.units[unit].guid end
    env.UnitNameUnmodified = function(unit)
        local u = c.units[unit]
        if u then return u.first, u.surname end
    end
    env.UnitTokenFromGUID = function(guid)
        assert(not env.issecretvalue(guid), 'Must not resolve a secret GUID')
        for token, unit in pairs(c.units) do if unit.guid == guid then return token end end
    end
    if options.noKillAPI then env.UnitGUID = false end
    env.print = function(message) table.insert(c.logs, message) end
    env.RaidNotice_AddMessage = function(_, message) table.insert(c.alerts, message) end
    env.PlaySound = function() c.sounds = c.sounds + 1; return true, 1 end
    env.RaidWarningFrame = {}
    env.ChatTypeInfo = { RAID_WARNING = {} }
    env.SOUNDKIT = { RAID_WARNING = 1 }
    env.ChatFrame_AddMessageEventFilter = function(event, callback)
        c.filters[event] = c.filters[event] or {}
        table.insert(c.filters[event], callback)
    end
    env.C_EventUtils = { IsEventValid = function(event)
        return event ~= 'CHAT_MSG_COMBAT_HOSTILE_DEATH' and not (event == 'PARTY_KILL' and options.noPartyKill)
    end }
    env.CreateFrame = function()
        local frame = { events = {}, scripts = {} }
        function frame:RegisterEvent(event)
            assert(env.C_EventUtils.IsEventValid(event), 'Unsupported client event')
            if event == 'PARTY_KILL' and options.rejectPartyKill then error('Registration blocked') end
            self.events[event] = true
            return true
        end
        function frame:SetScript(event, callback) self.scripts[event] = callback end
        table.insert(c.frames, frame)
        return frame
    end
    env.C_ChatInfo = {
        RegisterAddonMessagePrefix = function(prefix)
            c.prefix = prefix
            return options.registration or 0
        end,
        SendAddonMessage = function(prefix, message, channel)
            assert(prefix == c.prefix and channel == 'GUILD')
            assert(#prefix + #message <= 255)
            if c.sendError then error('Send failed') end
            if c.sendResult and c.sendResult ~= 0 then return c.sendResult end
            local packet = { prefix = prefix, message = message, channel = channel, sender = name }
            table.insert(world.packets, packet)
            table.insert(world.pending, packet)
            return 0
        end,
    }
    if options.noAPI then env.C_ChatInfo = false end
    for _, file in ipairs({'Core.lua', 'RankingSync.lua', 'Kills.lua', 'KillDetection.lua', 'GuildKills.lua'}) do
        assert(load(sources[file], file, 't', env))('HuntLista', {})
    end
    c.env = env
    env.HuntLista.CheckUnit = function() end
    function c:unit(token, guid, first, surname)
        self.units[token] = { guid = guid, first = first, surname = surname }
    end
    function c:kill(victimGUID, attackerGUID)
        self:event('PARTY_KILL', attackerGUID or self.units.player.guid, victimGUID)
    end
    function c:event(event, ...)
        for _, f in ipairs(self.frames) do
            if f.events[event] then f.scripts.OnEvent(f, event, ...) end
        end
    end
    function c:chat(message, event)
        event = event or 'CHAT_MSG_SYSTEM'
        assert(self.filters[event], 'Missing chat filter for ' .. event)
        for _, callback in ipairs(self.filters[event]) do
            assert(callback(nil, event, message) == false)
        end
    end
    function c:poll()
        for _, f in ipairs(self.frames) do
            if f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.21) end
        end
    end
    function c:packet(packet)
        self:event('CHAT_MSG_ADDON', packet.prefix, packet.message, packet.channel, packet.sender)
    end
    function c:command(command) self.env.SlashCmdList.HUNTLISTA(command) end
    c:event('ADDON_LOADED', 'HuntLista')
    c:event('PLAYER_LOGIN')
    table.insert(world.clients, c)
    return c
end
function deliver()
    local pending = world.pending
    world.pending = {}
    for _, packet in ipairs(pending) do
        for _, c in ipairs(world.clients) do c:packet(packet) end
    end
end
`;

function scenario(code) { runLua(setup + '\n' + code); }

test('confirmed kill reaches guild clients once, without relaying or changing their counters', () => {
    scenario(`
        local alice = client('Alice Archer-Realm')
        local bob = client('Bob Warrior-Realm')
        local carol = client('Carol Healer-Realm')
        alice:chat('You have slain Mega Enemy.')
        alice:chat('You have slain Mega Enemy.', 'CHAT_MSG_COMBAT_MISC_INFO')
        alice:chat('You have slain Mega Enemy.')
        assert(#world.packets == 1)
        deliver()
        for _, c in ipairs(world.clients) do assert(#c.alerts == 1 and c.sounds == 1) end
        assert(bob.alerts[1]:find('Alice Archer-Realm', 1, true))
        assert(bob.alerts[1]:find('Mega Enemy', 1, true))
        assert(alice.env.HuntLista:GetKillCount('Mega Enemy') == 1)
        assert(bob.env.HuntLista:GetTotalKills() == 0)
        assert(carol.env.HuntLista:GetTotalKills() == 0)
        bob:packet(world.packets[1])
        assert(#bob.alerts == 1 and #world.packets == 1)
    `);
});

test('watching a target die does not count a kill; chat confirmation counts once per cooldown', () => {
    scenario(`
        local alice = client('Alice')
        alice.targetExists = true
        alice:poll()
        alice.targetAlive = false
        alice:poll()
        assert(alice.env.HuntLista:GetTotalKills() == 0 and #alice.alerts == 0 and #world.packets == 0)
        alice:chat('Mega Enemy dies.')
        assert(alice.env.HuntLista:GetTotalKills() == 0 and #alice.alerts == 0 and #world.packets == 0)
        alice:chat('You have slain Mega Enemy.')
        assert(alice.env.HuntLista:GetKillCount('Mega Enemy') == 1 and #world.packets == 1)
        assert(alice.env.HuntLista:GetKillCount('Mega Rival') == 0)
        alice:chat('You have slain Mega Enemy.')
        assert(#world.packets == 1)
        world.now = world.now + 4
        alice:chat('You have slain Mega Enemy.')
        assert(alice.env.HuntLista:GetKillCount('Mega Enemy') == 2 and #world.packets == 2 and #alice.alerts == 2)
    `);
});

test('legacy abbreviated counts are readable for a unique full name', () => {
    scenario(`
        local alice = client('Alice')
        alice.env.HuntListaDB.kills.bad = { count = 2 }
        alice.env.HuntListaDB.kills.mega = { count = 3 }
        assert(alice.env.HuntLista:GetKillCount('Bad Guy') == 2)
        assert(alice.env.HuntLista:GetKillCount('Mega Enemy') == 0)
        assert(alice.env.HuntLista:GetKillCount('Mega Rival') == 0)
        assert(alice.env.HuntLista:GetTotalKills() == 5)
    `);
});

test('manual corrections stay local; unconfirmed, ambiguous and off-list kills do not count', () => {
    scenario(`
        local alice = client('Alice')
        alice:command('kill Bad')
        alice:command('kill Bad Guy')
        assert(alice.env.HuntLista:GetKillCount('Bad Guy') == 1)
        world.now = world.now + 4
        for _, message in ipairs({
            'Someone says You have slain Bad Guy.', 'You were slain by Bad Guy.', 'You hit Bad Guy for 300.',
            'Slain Bad Guy.', 'Killed Bad Guy.', 'Zabijasz Bad Guy.', 'You have slain Unknown Player.',
            'You have slain Bad.', 'You have slain Mega.', 'You have slain Mega-Realm.', 'You have slain Bad Guy-Realm.',
            'You have slain Case Conflict.', 'You have slain |Hitem:1|hBad Guy|h.'
        }) do alice:chat(message) end
        assert(alice.env.HuntLista:GetTotalKills() == 1 and #alice.alerts == 1 and #world.packets == 0)
        alice.secret = 'You have slain Bad Guy.'
        alice:chat(alice.secret)
        assert(alice.env.HuntLista:GetTotalKills() == 1 and #world.packets == 0)
    `);
});

test('colored and linked full names and Polish messages retain Unicode', () => {
    scenario(`
        local alice = client('Alice')
        local bob = client('Bob')
        alice:chat('|cffffffffYou have slain |Hplayer:Tollwütige Fledermaus|h[Tollwütige Fledermaus]|h.|r')
        alice:chat('Zabiłeś Bad Guy!')
        deliver()
        assert(alice.env.HuntLista:GetKillCount('Tollwütige Fledermaus') == 1)
        assert(alice.env.HuntLista:GetKillCount('Bad Guy') == 1)
        assert(#bob.alerts == 2)
        assert(bob.alerts[1]:find('Tollwütige Fledermaus', 1, true))
        assert(bob.alerts[2]:find('Bad Guy', 1, true))
    `);
});

test('off switch, addon-disabled state, no guild and sound setting are respected', () => {
    scenario(`
        local alice = client('Alice')
        local bob = client('Bob')
        local carol = client('Carol')
        local dave = client('Dave')
        bob:command('guildkills off')
        carol.env.HuntListaDB.sound = false
        dave.inGuild = false
        alice:chat('You have slain Mega Enemy.')
        deliver()
        assert(#bob.alerts == 0 and #dave.alerts == 0)
        assert(#carol.alerts == 1 and carol.sounds == 0)
        alice:command('guildkills off')
        alice:chat('You have slain Bad Guy.')
        assert(#world.packets == 1)
        alice:command('guildkills on')
        alice.env.HuntListaDB.enabled = false
        alice:chat('You have slain Bad Guy.')
        assert(#world.packets == 1)
    `);
});

test('invalid, non-guild and secret packets are ignored; old recipient data still gets alerts', () => {
    scenario(`
        local bob = client('Bob')
        for _, p in ipairs({
            {prefix='Other', message='1\tBad Guy', channel='GUILD', sender='Alice'},
            {prefix='HuntListaKill', message='1\tBad Guy', channel='WHISPER', sender='Alice'},
            {prefix='HuntListaKill', message='2\tBad Guy', channel='GUILD', sender='Alice'},
            {prefix='HuntListaKill', message='1\tBad Guy\tSpoofed Killer', channel='GUILD', sender='Alice'},
            {prefix='HuntListaKill', message='1\t|cffff0000Bad Guy', channel='GUILD', sender='Alice'},
            {prefix='HuntListaKill', message='1\tBad Guy', channel='GUILD', sender='|Hbad|h'},
            {prefix='HuntListaKill', message='1\t' .. string.rep('A', 129), channel='GUILD', sender='Alice'},
        }) do bob:packet(p) end
        bob.secret = '1\tBad Guy'
        bob:packet({prefix='HuntListaKill', message=bob.secret, channel='GUILD', sender='Alice'})
        assert(#bob.alerts == 0 and #world.packets == 0)
        bob.secret = nil
        bob.env.HuntLista_Lookup = {}
        bob:packet({prefix='HuntListaKill', message='1\tNew Enemy', channel='GUILD', sender='Alice'})
        assert(#bob.alerts == 1 and bob.env.HuntLista:GetTotalKills() == 0)
    `);
});

test('registration and send failures remain local, do not claim delivery, and can recover', () => {
    scenario(`
        local unavailable = client('Unavailable', {noAPI=true})
        local rejected = client('Rejected', {registration=3})
        local duplicate = client('Duplicate', {registration=1})
        unavailable:chat('You have slain Mega Enemy.')
        rejected:chat('You have slain Mega Enemy.')
        assert(#world.packets == 0 and #unavailable.alerts == 1 and #rejected.alerts == 1)
        assert(not unavailable.alerts[1]:find('GILDIA', 1, true))
        duplicate.sendResult = 11
        duplicate:chat('You have slain Mega Enemy.')
        assert(#world.packets == 0 and #duplicate.alerts == 1)
        assert(duplicate.env.HuntLista.guildKillStatus:find('nie wyslano', 1, true))
        duplicate.sendResult = 0
        duplicate:chat('You have slain Mega Enemy.')
        assert(#world.packets == 1 and #duplicate.alerts == 1)
        assert(duplicate.env.HuntLista:GetKillCount('Mega Enemy') == 1)
        duplicate.sendError = true
        duplicate:chat('You have slain Bad Guy.')
        assert(#world.packets == 1)
        assert(duplicate.env.HuntLista.guildKillStatus:find('nie wyslano', 1, true))
    `);
});

test('Forever PARTY_KILL resolves first name and surname and notifies guild once across chat duplicates', () => {
    scenario(`
        local alice, bob = client('Alice'), client('Bob')
        alice:unit('target', 'Player-1-victim', 'Mega', 'Enemy')
        alice:kill('Player-1-victim')
        alice:kill('Player-1-victim')
        alice:chat('You have slain Mega Enemy.')
        deliver()
        assert(alice.env.HuntLista:GetKillCount('Mega Enemy') == 1)
        assert(alice.env.HuntLista:GetKillCount('Mega Rival') == 0)
        assert(#world.packets == 1 and #alice.alerts == 1 and #bob.alerts == 1)
        assert(bob.env.HuntLista:GetTotalKills() == 0)
        world.now = world.now + 4
        alice:chat('You have slain Mega Enemy.')
        alice:kill('Player-1-victim')
        assert(alice.env.HuntLista:GetKillCount('Mega Enemy') == 2 and #world.packets == 2)
        alice:command('status')
        assert(table.concat(alice.logs, '\\n'):find('zdarzenia=3, naliczone z listy=1', 1, true))
    `);
});

test('pet killing blows count; other players, their pets, NPC victims and mere death do not', () => {
    scenario(`
        local alice = client('Alice')
        alice:unit('target', 'Player-1-victim', 'Bad', 'Guy')
        alice:kill('Player-1-victim', 'Player-1-someone-else')
        alice:kill('Player-1-victim', 'Pet-1-someone-else')
        alice:unit('nameplate1', 'Creature-1-npc', 'Bad', 'Guy')
        alice:kill('Creature-1-npc')
        alice:event('UNIT_DIED', 'Player-1-victim')
        alice:event('PLAYER_PVP_KILLS_CHANGED')
        assert(alice.env.HuntLista:GetTotalKills() == 0 and #world.packets == 0)
        alice:kill('Player-1-victim', alice.units.pet.guid)
        assert(alice.env.HuntLista:GetKillCount('Bad Guy') == 1 and #world.packets == 1)
    `);
});

test('GUID observations survive disappearing tokens without guessing or using stale names', () => {
    scenario(`
        for _, observation in ipairs({
            {'target', 'PLAYER_TARGET_CHANGED'}, {'mouseover', 'UPDATE_MOUSEOVER_UNIT'},
            {'nameplate1', 'NAME_PLATE_UNIT_ADDED'}
        }) do
            local alice = client('Alice-' .. observation[1])
            alice:unit(observation[1], 'Player-1-victim', 'Mega', 'Enemy')
            alice:event(observation[2], observation[1])
            alice.units[observation[1]] = nil
            alice:kill('Player-1-different-victim')
            assert(alice.env.HuntLista:GetTotalKills() == 0)
            alice:kill('Player-1-victim')
            assert(alice.env.HuntLista:GetKillCount('Mega Enemy') == 1)
            world.now = world.now + 121
            alice:kill('Player-1-victim')
            assert(alice.env.HuntLista:GetKillCount('Mega Enemy') == 1)
        end
        local reused = client('Reused')
        reused:unit('target', 'Player-1-other', 'Bad', 'Guy')
        reused.env.UnitTokenFromGUID = function() return 'target' end
        reused:kill('Player-1-victim')
        assert(reused.env.HuntLista:GetTotalKills() == 0)
    `);
});

test('the bounded GUID cache evicts old observations but retains the newest victim', () => {
    scenario(`
        local alice = client('Alice')
        for i = 1, 257 do
            alice:unit('mouseover', 'Player-1-' .. i, 'Bad', 'Guy')
            alice:event('UPDATE_MOUSEOVER_UNIT')
        end
        alice.units.mouseover = nil
        alice:kill('Player-1-1')
        assert(alice.env.HuntLista:GetTotalKills() == 0)
        alice:kill('Player-1-257')
        assert(alice.env.HuntLista:GetKillCount('Bad Guy') == 1)
    `);
});

test('secret event GUIDs, unit GUIDs, tokens and name parts are skipped before inspection', () => {
    scenario(`
        local alice = client('Alice')
        alice:unit('target', 'Player-1-victim', 'Mega', 'Enemy')
        alice:event('PLAYER_TARGET_CHANGED') -- A public cached name must not bypass a later secret.
        local secret = setmetatable({}, {
            __tostring = function() error('Secret value converted to text') end,
            __index = function() error('Secret value inspected') end,
            __concat = function() error('Secret value concatenated') end
        })
        alice.secret = secret
        alice:kill(secret)
        alice:kill('Player-1-victim', secret)
        alice.units.player.guid = secret
        alice:kill('Player-1-victim', 'Player-1-Alice')
        alice.units.player.guid = 'Player-1-Alice'
        alice.units.pet.guid = secret
        alice:kill('Player-1-victim', 'Pet-1-unknown')
        alice.units.pet.guid = 'Pet-1-Alice'
        alice.units.target.guid = secret
        alice.env.UnitTokenFromGUID = function() return 'target' end
        alice:kill('Player-1-victim')
        alice.units.target.guid = 'Player-1-victim'
        alice.units.target.first = secret
        alice:kill('Player-1-victim')
        alice.units.target.first = 'Mega'
        alice.units.target.surname = secret
        alice:kill('Player-1-victim')
        alice.env.UnitTokenFromGUID = function() return secret end
        alice:kill('Player-1-victim')
        assert(alice.env.HuntLista:GetTotalKills() == 0 and #world.packets == 0)
        alice:command('status')
        assert(table.concat(alice.logs, '\\n'):find('ukryte dane=8', 1, true))
    `);
});

test('native names retain Unicode and hyphens, and incomplete or ambiguous names never get guessed', () => {
    scenario(`
        local alice, bob = client('Alice'), client('Bob')
        for _, parts in ipairs({{'Mega', ''}, {'Case', 'Conflict'}, {'Off', 'List'}, {'Bad', '|Hitem:1'}}) do
            alice:unit('target', 'Player-1-victim', parts[1], parts[2])
            alice:kill('Player-1-victim')
        end
        assert(alice.env.HuntLista:GetTotalKills() == 0)
        alice:unit('target', 'Player-1-victim', 'Mega', 'Enemy-Slayer')
        alice:kill('Player-1-victim')
        alice:chat('You have slain Mega Enemy-Slayer.')
        alice:chat('You have slain Mega Enemy-Stranger.')
        assert(alice.env.HuntLista:GetKillCount('Mega Enemy-Slayer') == 1)
        assert(alice.env.HuntLista:GetKillCount('Mega Enemy') == 0)
        alice:unit('target', 'Player-1-other', 'Tollwütige', 'Fledermaus')
        alice:kill('Player-1-other')
        alice:unit('target', 'Player-1-full', 'Bad Guy', '')
        alice:kill('Player-1-full')
        deliver()
        assert(alice.env.HuntLista:GetTotalKills() == 3 and #bob.alerts == 3)
        assert(bob.alerts[1]:find('Mega Enemy-Slayer', 1, true))
        assert(bob.alerts[2]:find('Tollwütige Fledermaus', 1, true))
    `);
});

test('missing APIs, unsupported or blocked PARTY_KILL registration keep the chat fallback usable', () => {
    scenario(`
        for _, options in ipairs({{noKillAPI=true}, {noPartyKill=true}, {rejectPartyKill=true}}) do
            local alice = client('Alice', options)
            assert(alice.env.HuntLista.killDetectionStatus:find('pozostaja komunikaty czatu', 1, true))
            alice:unit('target', 'Player-1-victim', 'Mega', 'Enemy')
            alice:kill('Player-1-victim')
            assert(alice.env.HuntLista:GetTotalKills() == 0)
            alice:chat('You have slain Mega Enemy.')
            assert(alice.env.HuntLista:GetKillCount('Mega Enemy') == 1)
        end
        local alice = client('MissingName')
        alice.env.UnitTokenFromGUID = function() error('No token') end
        alice:kill('Player-1-victim')
        alice:command('status')
        assert(table.concat(alice.logs, '\\n'):find('brak pelnego nicku=1', 1, true))
        alice.env.UnitTokenFromGUID = function() return 'target' end
        alice:unit('target', 'Player-1-victim', 'Mega', 'Enemy')
        alice.env.UnitNameUnmodified = function() error('Unavailable name') end
        alice:kill('Player-1-victim')
        assert(alice.env.HuntLista:GetTotalKills() == 0)
    `);
});

test('native detection respects toggles and retries a failed guild send without double counting', () => {
    scenario(`
        local alice = client('Alice')
        alice:unit('target', 'Player-1-victim', 'Mega', 'Enemy')
        alice.env.HuntListaDB.enabled = false
        alice:kill('Player-1-victim')
        assert(alice.env.HuntLista:GetTotalKills() == 0 and #world.packets == 0)
        alice.env.HuntListaDB.enabled = true
        alice:command('guildkills off')
        alice:kill('Player-1-victim')
        assert(alice.env.HuntLista:GetTotalKills() == 1 and #world.packets == 0)
        alice:command('guildkills on')
        alice.sendResult = 11
        alice:kill('Player-1-victim')
        alice.sendResult = 0
        alice:kill('Player-1-victim')
        assert(alice.env.HuntLista:GetTotalKills() == 1 and #world.packets == 1)
        alice:event('PLAYER_LOGIN') -- Initializing twice must not create two listeners.
        world.now = world.now + 4
        alice:kill('Player-1-victim')
        assert(alice.env.HuntLista:GetTotalKills() == 2 and #world.packets == 2)
    `);
});

test('ranking opt-in applies to new confirmed kills and survives reload and local reset', () => {
    scenario(`
        local alice, bob = client('Alice'), client('Bob')
        local guid = alice.units.player.guid
        alice.env.HuntListaDB.kills.bad = { count = 12 }
        alice:chat('You have slain Mega Rival.')
        assert(alice.env.HuntListaSync == nil)
        alice:command('status')
        assert(table.concat(alice.logs):find('Synchronizacja rankingu: OFF', 1, true))
        assert(table.concat(alice.logs):find(guid, 1, true))

        alice:command('rankingsync on')
        alice:chat('You have slain Mega Rival.', 'CHAT_MSG_COMBAT_MISC_INFO')
        alice:command('kill Bad Guy')
        assert(alice.env.HuntListaSync == nil)
        alice:unit('target', 'Player-1-victim', 'Bad', 'Guy')
        alice:kill('Player-1-victim', alice.units.pet.guid)
        alice:chat('You have slain Bad Guy.')
        deliver()
        local journal = alice.env.HuntListaSync
        local character = journal.characters[guid]
        local stream = character.stream
        assert(stream:match('^[A-Za-z0-9:%-]+$') and #stream <= 160)
        assert(journal.version == 1 and character.counts['Mega Rival'] == nil)
        assert(character.counts['Bad Guy'].count == 1 and character.counts['Bad Guy'].lastAt == 1100)
        assert(alice.env.HuntListaDB.kills['bad guy'].count == 1)
        assert(bob.env.HuntListaSync == nil)

        alice.logs = {}
        alice:chat('You have slain Tollwütige Fledermaus.')
        assert(character.counts['Tollwütige Fledermaus'].count == 1)
        assert(not table.concat(alice.logs):find('/hunt kill', 1, true))
        alice:command('killreset')
        assert(alice.env.HuntLista:GetTotalKills() == 0 and character.counts['Bad Guy'].count == 1)

        local reloaded = client('Alice', {savedSync = journal, savedDB = alice.env.HuntListaDB})
        world.now = 105
        reloaded:chat('You have slain Bad Guy.')
        assert(reloaded.env.HuntListaSync.characters[guid].stream == stream)
        assert(character.counts['Bad Guy'].count == 2 and character.counts['Bad Guy'].lastAt == 1105)
        reloaded:command('status')
        assert(table.concat(reloaded.logs):find('Zabójstwa w dzienniku postaci: 3', 1, true))

        reloaded:command('rankingsync off')
        reloaded.logs = {}
        world.now = 110
        reloaded:chat('You have slain Bad Guy.')
        assert(character.counts['Bad Guy'].count == 2)
        assert(table.concat(reloaded.logs):find('/hunt kill Bad Guy', 1, true))
        reloaded:command('rankingsync on')
        world.now = 115
        reloaded:chat('You have slain Bad Guy.')
        assert(character.counts['Bad Guy'].count == 3 and character.stream == stream)
    `);
});

test('ranking stores character streams and opt-in separately in shared SavedVariables', () => {
    scenario(`
        local alice = client('Alice')
        alice:command('rankingsync on')
        alice:chat('You have slain Mega Enemy.')
        local journal = alice.env.HuntListaSync
        local alt = client('Alt', {savedSync = journal, savedDB = alice.env.HuntListaDB})
        local guid = alt.units.player.guid
        alt:chat('You have slain Mega Enemy.')
        assert(journal.characters[guid] == nil)
        alt:command('rankingsync on')
        world.now = 105
        alt:chat('You have slain Mega Enemy.')
        assert(journal.characters[guid].counts['Mega Enemy'].count == 1)
        local own = journal.characters[alice.units.player.guid]
        assert(own.counts['Mega Enemy'].count == 1 and own.stream ~= journal.characters[guid].stream)
    `);
});

test('ranking skips hidden player GUIDs while keeping chat kills and guild notices', () => {
    scenario(`
        local alice = client('Alice')
        alice:command('rankingsync on')
        local secret = setmetatable({}, {
            __tostring = function() error('Secret GUID converted to text') end,
            __index = function() error('Secret GUID inspected') end,
            __concat = function() error('Secret GUID concatenated') end
        })
        alice.secret = secret
        alice.units.player.guid = secret
        alice:chat('You have slain Bad Guy.')
        alice:command('status')
        assert(alice.env.HuntLista:GetTotalKills() == 1 and #world.packets == 1)
        assert(alice.env.HuntListaSync == nil)
        assert(table.concat(alice.logs):find('brak jawnego GUID postaci', 1, true))
    `);
});

test('invalid ranking SavedVariables preserve the original journal and report a local failure', () => {
    scenario(`
        for _, journal in ipairs({
            false,
            {version = 2, characters = {}},
            {version = 1, characters = {['Player-1-Bob'] = {stream = 'stream', counts = {
                ['Bad Guy'] = {count = -1, lastAt = 1100}
            }}}}
        }) do
            local alice = client('Alice', {savedSync = journal})
            alice.env.HuntListaDB.rankingSyncEnabled = {[alice.units.player.guid] = true}
            local before = #world.packets
            alice:chat('You have slain Mega Enemy.')
            alice:command('status')
            assert(alice.env.HuntListaSync == journal)
            if type(journal) == 'table' then assert(journal.characters[alice.units.player.guid] == nil) end
            assert(alice.env.HuntLista:GetTotalKills() == 1 and #world.packets == before + 1)
            assert(table.concat(alice.logs):find('nieprawidłowy zapis HuntListaSync', 1, true))
        end
    `);
});

test('ranking journal limits preserve existing entries and leave local kills usable', () => {
    scenario(`
        local journal = {version = 1, characters = {}}
        for i = 1, 64 do
            journal.characters['Player-1-' .. i] = {stream = 'stream-' .. i, counts = {}}
        end
        local full = journal.characters['Player-1-1'].counts
        full['Bad Guy'] = {count = 1000000000, lastAt = 1050}
        for i = 2, 256 do full['Victim ' .. i] = {count = 1, lastAt = 1050} end

        local alice = client('Alice', {savedSync = journal})
        alice:command('rankingsync on')
        alice:chat('You have slain Bad Guy.')
        assert(journal.characters[alice.units.player.guid] == nil)
        assert(alice.env.HuntLista:GetTotalKills() == 1)
        assert(table.concat(alice.logs):find('limit postaci', 1, true))

        local existing = client('Existing', {guid = 'Player-1-1', savedSync = journal})
        existing:command('rankingsync on')
        existing:chat('You have slain Bad Guy.')
        existing:chat('You have slain Mega Enemy.')
        assert(full['Bad Guy'].count == 1000000000 and full['Bad Guy'].lastAt == 1050)
        assert(full['Mega Enemy'] == nil and full['Victim 256'].count == 1)
        assert(existing.env.HuntLista:GetTotalKills() == 2)
        local logs = table.concat(existing.logs)
        assert(logs:find('limit zabójstw', 1, true) and logs:find('limit nicków', 1, true))
    `);
});
