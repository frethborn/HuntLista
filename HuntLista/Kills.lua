-- ============================================================
-- Hunt Lista - Licznik zabojstw (lokalny) + alert przy killu
-- ============================================================

HuntLista = HuntLista or {}
local HL = HuntLista

local lastTargetName
local lastTargetOnList = false
local lastTargetWasAlive = false
local recentKillLock = {}

local function EnsureKillsDB()
    if not HuntListaDB then HuntListaDB = {} end
    if not HuntListaDB.kills then HuntListaDB.kills = {} end
end

local function KillKey(name)
    if not name then return nil end
    name = strlower(strtrim(name))
    if HL.GetInfo then
        local info = HL:GetInfo(name)
        if info and info.name then
            return strlower(strtrim(info.name))
        end
    end
    return name
end

function HL:GetKillCount(name)
    EnsureKillsDB()
    local key = KillKey(name)
    if not key then return 0 end
    local e = HuntListaDB.kills[key]
    if e then return e.count or 0 end
    local fw = key:match("^(%S+)")
    if fw and fw ~= key then
        for k, v in pairs(HuntListaDB.kills) do
            if k == fw or k:sub(1, #fw + 1) == fw .. " " then
                return v.count or 0
            end
        end
    end
    return 0
end

function HL:GetTotalKills()
    EnsureKillsDB()
    local n = 0
    for _, v in pairs(HuntListaDB.kills) do
        n = n + (v.count or 0)
    end
    return n
end

local function ShowKillAlert(display, count, reason)
    local reasonTxt = (reason and reason ~= "") and (" - " .. reason) or ""
    local msg = "|cff00ff00[HUNT KILL]|r |cffffff00" .. display .. "|r |cff88ff88x" .. count .. "|r" .. reasonTxt

    if RaidNotice_AddMessage and RaidWarningFrame then
        pcall(function()
            RaidNotice_AddMessage(RaidWarningFrame, msg, ChatTypeInfo["RAID_WARNING"] or { r = 1, g = 0.2, b = 0.2 })
        end)
    end

    if UIErrorsFrame and UIErrorsFrame.AddMessage then
        pcall(function()
            UIErrorsFrame:AddMessage("|cff00ff00HUNT KILL:|r " .. display .. " (x" .. count .. ")", 1, 0.85, 0.2)
        end)
    end

    print(msg)
    print("|cffaaaaaaZglos na Discord:|r /hunt kill " .. display)

    if HL.PlayHuntSound then
        HL:PlayHuntSound()
    end
end

function HL:RecordKill(name, source)
    if not name or name == "" then return false end
    if type(name) ~= "string" then return false end

    local info = HL.GetInfo and HL:GetInfo(name)
    if not info then
        if HuntListaDB and HuntListaDB.debug then
            print("|cff888888[HL kills]|r nie na liscie: " .. tostring(name))
        end
        return false
    end

    local display = info.name or name
    local key = strlower(strtrim(display))

    -- Poll mogl juz naliczyc smierc. Potwierdzenie nadal musi dotrzec do gildii;
    -- BroadcastGuildKill ma niezalezna ochrone przed podwojnym wyslaniem.
    if source == "chat" and HL.BroadcastGuildKill then
        HL:BroadcastGuildKill(name)
    end

    local now = GetTime()
    if recentKillLock[key] and (now - recentKillLock[key]) < 3 then
        return false
    end
    recentKillLock[key] = now

    EnsureKillsDB()
    local e = HuntListaDB.kills[key]
    if not e then
        e = { count = 0, lastAt = 0, name = display }
        HuntListaDB.kills[key] = e
    end
    e.count = (e.count or 0) + 1
    e.lastAt = time and time() or 0
    e.name = display

    ShowKillAlert(display, e.count, info.reason)

    if HuntListaDB and HuntListaDB.debug then
        print("|cff888888[HL kills]|r source=" .. tostring(source))
    end

    if HL.RefreshList and HuntListaFrame and HuntListaFrame:IsShown() then
        HL:RefreshList()
    end
    return true
end

function HL:ResetKills(name)
    EnsureKillsDB()
    if not name or name == "" then
        wipe(HuntListaDB.kills)
        print("|cff00ff00Hunt Lista|r licznik zabojstw wyzerowany")
        return
    end
    local key = KillKey(name)
    if key and HuntListaDB.kills[key] then
        HuntListaDB.kills[key] = nil
        print("|cff00ff00Hunt Lista|r wyzerowano: " .. name)
    else
        print("|cff00ff00Hunt Lista|r brak wpisu: " .. tostring(name))
    end
end

function HL:PrintKills()
    EnsureKillsDB()
    local rows = {}
    for k, v in pairs(HuntListaDB.kills) do
        table.insert(rows, { name = v.name or k, count = v.count or 0 })
    end
    table.sort(rows, function(a, b)
        if a.count == b.count then return a.name < b.name end
        return a.count > b.count
    end)
    print("|cff00ff00Hunt Lista|r Twoje zabojstwa (osoby z listy):")
    if #rows == 0 then
        print("  (brak)")
        return
    end
    for _, r in ipairs(rows) do
        print("  |cffff6666" .. r.name .. "|r  x" .. r.count)
    end
    print("  Razem: " .. HL:GetTotalKills())
end

local function TryParseKillChat(msg)
    if issecretvalue and issecretvalue(msg) then return end
    if type(msg) ~= "string" then return end
    msg = msg:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")
    msg = msg:gsub("|H.-|h", ""):gsub("|h", "")
    local patterns = {
        "^[Yy]ou have slain (.+)$",
        "^[Yy]ou slain (.+)$",
        "^[Ss]lain (.+)$",
        "^[Zz]abiles (.+)$",
        "^[Zz]abilas (.+)$",
        "^[Zz]abiłeś (.+)$",
        "^[Zz]abiłaś (.+)$",
        "^[Zz]abijasz (.+)$",
        "^[Yy]ou have killed (.+)$",
        "^[Kk]illed (.+)$",
    }
    for _, pat in ipairs(patterns) do
        local m = msg:match(pat)
        if m then
            m = strtrim(m)
            m = m:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")
            m = m:gsub("|H.-|h", ""):gsub("|h", "")
            m = m:gsub("[%.%!]+$", "")
            if m ~= "" then
                HL:RecordKill(m, "chat")
                return
            end
        end
    end
end

-- Filtry czatu zamiast RegisterEvent (Forever: mniej taint / ADDON_ACTION_FORBIDDEN)
if ChatFrame_AddMessageEventFilter then
    local function filter(_, _, msg)
        TryParseKillChat(msg)
        return false
    end
    for _, ev in ipairs({
        "CHAT_MSG_SYSTEM",
        "CHAT_MSG_COMBAT_MISC_INFO",
        "CHAT_MSG_COMBAT_XP_GAIN",
        "CHAT_MSG_COMBAT_HOSTILE_DEATH",
        "CHAT_MSG_COMBAT_HOSTILEPLAYER_HITS",
        "CHAT_MSG_SPELL_HOSTILEPLAYER_DAMAGE",
    }) do
        pcall(ChatFrame_AddMessageEventFilter, ev, filter)
    end
end

local poll = CreateFrame("Frame")
poll:SetScript("OnUpdate", function(self, elapsed)
    self.t = (self.t or 0) + elapsed
    if self.t < 0.2 then return end
    self.t = 0

    if not UnitExists("target") or not UnitIsPlayer("target") then
        lastTargetName = nil
        lastTargetOnList = false
        lastTargetWasAlive = false
        return
    end

    local okN, n = pcall(UnitName, "target")
    if not okN or type(n) ~= "string" then return end
    if issecretvalue and issecretvalue(n) then return end

    local full = (HL.ResolveFullName and HL:ResolveFullName(n)) or n
    local onList = HL.IsOnList and HL:IsOnList(full) or false
    local alive = not UnitIsDeadOrGhost("target")

    if lastTargetName ~= full then
        lastTargetName = full
        lastTargetOnList = onList
        lastTargetWasAlive = alive
        return
    end

    if lastTargetOnList and lastTargetWasAlive and not alive then
        HL:RecordKill(full, "target-death")
    end

    lastTargetOnList = onList
    lastTargetWasAlive = alive
end)

HuntLista.GetKillCount = HL.GetKillCount
HuntLista.GetTotalKills = HL.GetTotalKills
HuntLista.RecordKill = HL.RecordKill
HuntLista.ResetKills = HL.ResetKills
HuntLista.PrintKills = HL.PrintKills
