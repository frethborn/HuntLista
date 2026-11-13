const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const luaparse = require('luaparse');
const { runLua } = require('./lua');
const addonPath = path.join(__dirname, '../../HuntLista');
const source = fs.readFileSync(path.join(addonPath, 'Death.lua'), 'utf8');

const mocks = `
HuntListaDB = { deathPopup = true }
HuntLista_Data = { players = {} }
now = 100
dead = false
targetName = 'Uninvolved Friend'
enemy = false
strlower = string.lower
strtrim = function(s) return (s:gsub('^%s+', ''):gsub('%s+$', '')) end
UnitExists = function(unit) return unit == 'target' and targetName ~= nil end
UnitIsPlayer = function(unit) return unit == 'target' end
UnitName = function() return targetName end
UnitCanAttack = function() return enemy end
UnitAffectingCombat = function() return true end
UnitIsDeadOrGhost = function() return dead end
GetTime = function() return now end
logs = {}
print = function(message) table.insert(logs, message) end
filters = {}
ChatFrame_AddMessageEventFilter = function(event, callback) filters[event] = callback end
frames = {}
local function widget()
    local w = { scripts = {}, shown = false, shows = 0 }
    w.SetScript = function(self, event, callback) self.scripts[event] = callback end
    w.SetText = function(self, text) self.text = text end
    w.Show = function(self) self.shown = true; self.shows = self.shows + 1 end
    w.Hide = function(self) self.shown = false end
    w.CreateFontString = function() return widget() end
    w.CreateTexture = function() return widget() end
    return setmetatable(w, { __index = function(_, key)
        if key:match('^[A-Z]') then return function() end end
    end })
end
CreateFrame = function(_, name)
    local f = widget()
    table.insert(frames, f)
    if name then _G[name] = f end
    return f
end
function tick(isDead, seconds)
    dead = isDead
    now = now + (seconds or 0.16)
    for _, f in ipairs(frames) do
        if f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.16) end
    end
end
function chat(message)
    assert(filters.CHAT_MSG_SYSTEM(nil, nil, message) == false)
end
function noPopup()
    assert(not HuntListaDeathFrame or not HuntListaDeathFrame.shown)
end
`;

function scenario(code) { runLua(mocks + '\n' + source + '\n' + code); }

test('all addon files parse as Lua 5.1', () => {
    for (const file of fs.readdirSync(addonPath).filter(name => name.endsWith('.lua'))) {
        luaparse.parse(fs.readFileSync(path.join(addonPath, file), 'utf8'), { luaVersion: '5.1' });
    }
});

test('confirmed killer survives a longer friendly target and an ambiguous cached first name', () => {
    scenario(`
        HuntLista.NameCache.eve = 'Eve Innocent Longname'
        chat('You were slain by Eve.')
        tick(true)
        tick(true, 0.31)
        assert(HuntListaDeathFrame.shown)
        assert(HuntListaDeathFrame.editBox.text == 'Eve')
        local count = HuntListaDeathFrame.shows
        chat('You were slain by Eve.')
        tick(true)
        assert(HuntListaDeathFrame.shows == count)
    `);
});

test('enemy target, combat polling and someone else dying never identify a killer', () => {
    scenario(`
        enemy = true
        tick(false)
        chat('Someone was slain by Wrong Killer')
        tick(true)
        tick(true, 0.31)
        noPopup()
    `);
});

test('a friendly target cannot become the killer when no death or damage message exists', () => {
    scenario(`
        enemy = false
        targetName = 'Uninvolved Friend'
        tick(true)
        tick(true, 0.31)
        noPopup()
    `);
});

test('combat log is an unconfirmed attack, preserves ability text and yields to a confirmed killer', () => {
    scenario(`
        HuntLista.NameCache.eve = 'Eve Innocent Longname'
        chat('Eve Deadly Poison II damaged You 97 Nature.')
        tick(true)
        tick(true, 0.31)
        assert(HuntListaDeathFrame.editBox.text == 'Eve Deadly Poison II')
        assert(HuntListaDeathFrame.title.text:find('Ostatni atak', 1, true))
        assert(HuntListaDeathFrame.subtitle.text:find('niepotwierdzony', 1, true))
        local count = HuntListaDeathFrame.shows
        tick(true)
        assert(HuntListaDeathFrame.shows == count)
        chat('You were slain by Eve Short.')
        chat('Other Attacker Melee hit You 46 Physical.')
        tick(true)
        assert(HuntListaDeathFrame.editBox.text == 'Eve Short')
        assert(HuntListaDeathFrame.title.text:find('Zabil cie', 1, true))
        assert(HuntListaDeathFrame.shows == count + 1)
        chat('Third Attacker hit You 10 Physical.')
        tick(true)
        assert(HuntListaDeathFrame.editBox.text == 'Eve Short')
        assert(HuntListaDeathFrame.shows == count + 1)
    `);
});

test('stale combat damage and damage from a previous life do not populate the death popup', () => {
    scenario(`
        chat('Old Attacker Melee hit You 46 Physical.')
        tick(true, 13)
        tick(true, 0.31)
        noPopup()
        chat('Current Attacker Melee hit You 46 Physical.')
        tick(true)
        assert(HuntListaDeathFrame.editBox.text == 'Current Attacker')
        assert(HuntListaDeathFrame.title.text:find('Ostatni atak', 1, true))
        tick(false)
        noPopup()
        tick(true)
        tick(true, 0.31)
        noPopup()
    `);
});

test('a delayed death message still opens the popup', () => {
    scenario(`
        tick(true)
        tick(true, 0.31)
        noPopup()
        chat('You were killed by Late Killer')
        tick(true)
        assert(HuntListaDeathFrame.editBox.text == 'Late Killer')
    `);
});

test('stale messages and previous lives cannot leak into a new death', () => {
    scenario(`
        chat('You were slain by Old Killer')
        tick(true, 6)
        tick(true, 0.31)
        noPopup()
        chat('You were slain by Current Killer')
        tick(true)
        assert(HuntListaDeathFrame.editBox.text == 'Current Killer')
        tick(false)
        noPopup()
        tick(true)
        tick(true, 0.31)
        noPopup()
    `);
});

test('resurrection during the wait cancels the popup; disabled popup stays hidden', () => {
    scenario(`
        chat('You were slain by Eve')
        tick(true)
        tick(false)
        tick(false, 1)
        noPopup()
        HuntListaDB.deathPopup = false
        chat('You were slain by Eve')
        tick(true)
        tick(true, 0.31)
        noPopup()
    `);
});

test('full Unicode names and supported Polish messages survive unchanged', () => {
    scenario(`
        chat('Zabił cię Tollwütige Fledermaus')
        tick(true)
        tick(true, 0.31)
        assert(HuntListaDeathFrame.editBox.text == 'Tollwütige Fledermaus')
        tick(false)
        chat('Zabita przez Mega Chad')
        tick(true)
        tick(true, 0.31)
        assert(HuntListaDeathFrame.editBox.text == 'Mega Chad')
    `);
});

test('manual killer popup remains available without a death message', () => {
    scenario(`
        HuntLista:ShowKillerPopup('Manual Test')
        assert(HuntListaDeathFrame.editBox.text == 'Manual Test')
        assert(HuntListaDeathFrame.shown)
    `);
});

test('debug polling stays quiet without a fresh killer and logs a late match only once', () => {
    scenario(`
        HuntListaDB.debug = true
        chat('You were slain by Stale Killer')
        tick(true, 6)
        for i = 1, 100 do tick(true) end
        for _, message in ipairs(logs) do assert(not message:find('TryShow', 1, true)) end
        chat('You were slain by Late Killer')
        for i = 1, 100 do tick(true) end
        local count = 0
        for _, message in ipairs(logs) do
            if message:find('TryShow', 1, true) then count = count + 1 end
        end
        assert(count == 1)
    `);
});
