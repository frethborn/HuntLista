const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { runLua } = require('./lua');
const { luaString } = require('../data');

const core = fs.readFileSync(path.join(__dirname, '../../HuntLista/Core.lua'), 'utf8');

function scenario(code) {
    runLua(`
        SlashCmdList = {}
        CreateFrame = function() return { RegisterEvent = function() end, SetScript = function() end } end
        assert(load(${luaString(core)}, 'Core.lua'))('HuntLista', {})
        HuntListaDB = { soundPreset = 'test' }
        HuntLista.SoundPresets.test = { ids = { 1, 2, 3 }, files = { 'one', 'two', 'three', 'four' } }
        local calls = {}
        local function record(value, channel)
            table.insert(calls, tostring(value) .. ':' .. (channel or 'default'))
        end
        local function expectCalls(expected)
            local actual = table.concat(calls, ', ')
            assert(actual == expected, 'Playback calls: ' .. actual)
        end
        ${code}
    `);
}

test('first successful sound kit stops playback, skipping false and nil results', () => {
    scenario(`
        PlaySound = function(id, channel)
            record(id, channel)
            if id == 1 then return false, 42 end
            if id == 3 then return true, 42 end
        end
        PlaySoundFile = record
        HuntLista:PlayHuntSound()
        expectCalls('1:Master, 2:Master, 3:Master')
    `);
});

test('sound kit can play on the default channel after Master fails', () => {
    scenario(`
        PlaySound = function(id, channel)
            record(id, channel)
            if channel then error('Master unavailable') end
            return id == 2
        end
        PlaySoundFile = record
        HuntLista:PlayHuntSound()
        expectCalls('1:Master, 2:Master, 3:Master, 1:default, 2:default')
    `);
});

test('file fallback skips errors and false results and stops at its first success', () => {
    scenario(`
        PlaySound = record
        PlaySoundFile = function(file, channel)
            record(file, channel)
            if file == 'one' then error('File unavailable') end
            return file == 'three', 42
        end
        HuntLista:PlayHuntSound()
        expectCalls('1:Master, 2:Master, 3:Master, 1:default, 2:default, 3:default, one:Master, two:Master, three:Master')
    `);
});

test('files are tried without PlaySound and nil file results exhaust the preset', () => {
    scenario(`
        PlaySoundFile = record
        HuntLista:PlayHuntSound()
        expectCalls('one:Master, two:Master, three:Master, four:Master')
    `);
});

test('disabled sound skips all playback attempts', () => {
    scenario(`
        HuntListaDB.sound = false
        PlaySound = record
        PlaySoundFile = record
        HuntLista:PlayHuntSound()
        expectCalls('')
    `);
});
