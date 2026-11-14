local HL = HuntLista
local MAX_CHARACTERS, MAX_NAMES, MAX_COUNT = 64, 256, 1000000000
local MAX_TIMESTAMP = 8640000000000
local COOLDOWN = 3
local recent = {}
local lastError

local function PlainText(value)
    return (not issecretvalue or not issecretvalue(value)) and type(value) == "string"
end

local function ValidGUID(guid)
    return PlainText(guid) and #guid <= 128 and guid:match("^Player%-[A-Za-z0-9%-]+$") ~= nil
end

local function ReadPlayerGUID()
    local ok, guid = pcall(UnitGUID, "player")
    if ok and ValidGUID(guid) then return guid end
end

local function ValidName(name)
    return PlainText(name) and #name > 0 and #name <= 128
        and not name:find("[%c|]") and strtrim(name) == name
end

local function PositiveInteger(value, maximum)
    return type(value) == "number" and value >= 1 and value <= maximum and value == math.floor(value)
end

local function HasOnlyFields(value, first, second)
    if type(value) ~= "table" then return false end
    for key in pairs(value) do
        if key ~= first and key ~= second then return false end
    end
    return true
end

local function ReadJournal()
    local journal = HuntListaSync
    if journal == nil then return {}, 0 end
    if not HasOnlyFields(journal, "version", "characters") or journal.version ~= 1
        or type(journal.characters) ~= "table" then return nil end
    local characterCount = 0
    for guid, character in pairs(journal.characters) do
        characterCount = characterCount + 1
        if characterCount > MAX_CHARACTERS or not ValidGUID(guid)
            or not HasOnlyFields(character, "stream", "counts")
            or not PlainText(character.stream) or #character.stream > 160
            or not character.stream:match("^[A-Za-z0-9:%-]+$")
            or type(character.counts) ~= "table" then return nil end
        local nameCount = 0
        for name, entry in pairs(character.counts) do
            nameCount = nameCount + 1
            if nameCount > MAX_NAMES or not ValidName(name)
                or not HasOnlyFields(entry, "count", "lastAt")
                or not PositiveInteger(entry.count, MAX_COUNT)
                or not PositiveInteger(entry.lastAt, MAX_TIMESTAMP) then return nil end
        end
    end
    return journal.characters, characterCount
end

local function Failure(reason)
    if lastError ~= reason then
        print("|cffffaa00Hunt Lista|r Synchronizacja rankingu: " .. reason)
    end
    lastError = reason
    return false
end

local function OptIn()
    return HuntListaDB and HuntListaDB.rankingSyncEnabled
end

function HL:SetRankingSyncEnabled(enabled)
    local guid = ReadPlayerGUID()
    if not guid then return Failure("brak jawnego GUID postaci") end
    local optIn = OptIn()
    if optIn ~= nil and type(optIn) ~= "table" then
        return Failure("nieprawidłowe ustawienie synchronizacji postaci")
    end
    if enabled and not ReadJournal() then return Failure("nieprawidłowy zapis HuntListaSync") end
    optIn = optIn or {}
    optIn[guid] = enabled and true or nil
    HuntListaDB.rankingSyncEnabled = optIn
    print("Synchronizacja rankingu dla tej postaci: " .. (enabled and "ON" or "OFF"))
    return true
end

function HL:QueueRankingKill(name)
    local optIn = OptIn()
    if optIn ~= nil and type(optIn) ~= "table" then
        return Failure("nieprawidłowe ustawienie synchronizacji postaci")
    end
    local guid = ReadPlayerGUID()
    if not guid then
        if optIn and next(optIn) then return Failure("brak jawnego GUID postaci") end
        return false
    end
    local enabled = optIn and optIn[guid] == true
    if not ValidName(name) then
        if enabled then return Failure("nieprawidłowy nick celu") end
        return false
    end

    local key = guid .. ":" .. strlower(name)
    local now = GetTime()
    for other, observed in pairs(recent) do
        if now - observed.at >= COOLDOWN then recent[other] = nil end
    end
    if recent[key] then return recent[key].queued end
    if not enabled then
        -- A second confirmation must not import a kill seen before opt-in.
        recent[key] = { at = now, queued = false }
        return false
    end

    local characters, characterCount = ReadJournal()
    if not characters then return Failure("nieprawidłowy zapis HuntListaSync") end
    local at = time and time()
    if not PositiveInteger(at, MAX_TIMESTAMP) then return Failure("brak poprawnego czasu zabójstwa") end

    local character = characters[guid]
    if not character then
        if characterCount >= MAX_CHARACTERS then return Failure("limit postaci w HuntListaSync") end
        local stream = string.format("%.0f:%d:%d", at, math.random(0, 1073741823), math.random(0, 1073741823))
        character = { stream = stream, counts = {} }
        characters[guid] = character
    end
    local entry = character.counts[name]
    if entry then
        if entry.count >= MAX_COUNT then return Failure("limit zabójstw dla " .. name) end
        entry.count = entry.count + 1
        entry.lastAt = at
    else
        local nameCount = 0
        for _ in pairs(character.counts) do nameCount = nameCount + 1 end
        if nameCount >= MAX_NAMES then return Failure("limit nicków w HuntListaSync dla tej postaci") end
        character.counts[name] = { count = 1, lastAt = at }
    end
    if HuntListaSync == nil then HuntListaSync = { version = 1, characters = characters } end
    recent[key] = { at = now, queued = true }
    lastError = nil
    return true
end

function HL:PrintRankingSyncStatus()
    local guid = ReadPlayerGUID()
    local optIn = OptIn()
    local enabled = guid and type(optIn) == "table" and optIn[guid] == true
    print("  Synchronizacja rankingu: " .. (enabled and "ON" or "OFF") .. " (/hl rankingsync on|off)")
    print("  GUID postaci: " .. (guid or "niedostępny"))
    local characters = ReadJournal()
    if not characters then
        print("  Nieprawidłowy zapis HuntListaSync")
    elseif guid then
        local total = 0
        local character = characters[guid]
        if character then
            for _, entry in pairs(character.counts) do total = total + entry.count end
        end
        print("  Zabójstwa w dzienniku postaci: " .. total)
    end
    if lastError then print("  Ostatni błąd zapisu: " .. lastError) end
    print("  /reload lub wylogowanie zapisuje dziennik na dysku. Wysyłka wymaga programu synchronizacji.")
end
