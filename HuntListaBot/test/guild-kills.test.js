const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { runLua } = require('./lua');
const { luaString } = require('../data');
const addonPath = path.join(__dirname, '../../HuntLista');
const sources = Object.fromEntries(['Core.lua', 'Kills.lua', 'GuildKills.lua'].map(name =>
    [name, luaString(fs.readFileSync(path.join(addonPath, name), 'utf8'))]));

// Separate Lua environments model clients sharing only addon messages, never SavedVariables.
const setup = `
local sources = { ${Object.entries(sources).map(([name, code]) => `[${luaString(name)}] = ${code}`).join(',')} }
world = { now = 100, clients = {}, packets = {}, pending = {} }
function client(name, options)
    options = options or {}
    local c = { name = name, frames = {}, filters = {}, alerts = {}, logs = {}, sounds = 0,
        inGuild = true, targetAlive = true, targetExists = false }
    local env = setmetatable({}, { __index = _G })
    env._G = env
    env.HuntListaDB = {}
    env.HuntLista_Data = { version = 'test', players = {
        ['Mega Enemy'] = {}, ['Mega Rival'] = {}, ['Bad Guy'] = {}, ['Tollwütige Fledermaus'] = {},
        ['Case Conflict'] = {}, ['case conflict'] = {}
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
    env.issecretvalue = function(value) return value == c.secret end
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
    env.C_EventUtils = { IsEventValid = function(event) return event ~= 'CHAT_MSG_COMBAT_HOSTILE_DEATH' end }
    env.CreateFrame = function()
        local frame = { events = {}, scripts = {} }
        function frame:RegisterEvent(event)
            assert(env.C_EventUtils.IsEventValid(event), 'Unsupported client event')
            self.events[event] = true
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
    for _, file in ipairs({'Core.lua', 'Kills.lua', 'GuildKills.lua'}) do
        assert(load(sources[file], file, 't', env))('HuntLista', {})
    end
    c.env = env
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
            'You have slain Bad.', 'You have slain Mega.', 'You have slain Mega-Realm.',
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
        alice:chat('Zabiłeś Bad Guy-Realm!')
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
