const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { parseSavedVariables, MAX_FILE, validGUID } = require('./ranking-sync');

function validateConfig(config) {
    const url = new URL(config.endpoint);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/v1/kills'
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('Endpoint musi być HTTPS /v1/kills (HTTP tylko na loopback do testów).');
    }
    if (typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(config.token)
        || typeof config.savedVariables !== 'string' || !config.savedVariables.trim()
        || !Array.isArray(config.characters) || !config.characters.length || !config.characters.every(validGUID)) {
        throw new Error('Uzupełnij token, plik SavedVariables i GUID-y postaci w konfiguracji.');
    }
    const intervalSeconds = config.intervalSeconds ?? 30;
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 3600) throw new Error('Interwał: 10–3600 sekund.');
    return { ...config, endpoint: url.href, intervalSeconds };
}

function createCompanion(rawConfig, dependencies = {}) {
    const config = validateConfig(rawConfig);
    const fetchImpl = dependencies.fetch || fetch;
    const read = dependencies.read || (async () => {
        const file = await fs.open(config.savedVariables, 'r');
        try {
            if ((await file.stat()).size > MAX_FILE) throw new Error('SavedVariables przekracza 8 MiB.');
            const buffer = Buffer.alloc(MAX_FILE + 1);
            let size = 0, bytesRead;
            do { ({ bytesRead } = await file.read(buffer, size, buffer.length - size, null)); size += bytesRead; }
            while (bytesRead && size < buffer.length);
            if (size > MAX_FILE) throw new Error('SavedVariables przekracza 8 MiB.');
            return buffer.subarray(0, size);
        } finally { await file.close(); }
    });
    let acknowledged;
    let running = false;
    return {
        async sync() {
            if (running) return { unchanged: true };
            running = true;
            try {
                const records = parseSavedVariables(await read()).filter(r => config.characters.includes(r.playerGUID));
                const digest = createHash('sha256').update(JSON.stringify(records)).digest('hex');
                if (digest === acknowledged) return { unchanged: true };
                let added = 0, ignored = 0, stale = 0;
                for (let i = 0; i < records.length; i += 50) {
                    const response = await fetchImpl(config.endpoint, {
                        method: 'POST', headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ records: records.slice(i, i + 50) }),
                        redirect: 'error', signal: AbortSignal.timeout(15000),
                    });
                    if (!response.ok) throw new Error(`Synchronizacja HTTP ${response.status}; dane pozostają do ponowienia.`);
                    const result = await response.json();
                    if (result.ok !== true || !Number.isSafeInteger(result.added) || result.added < 0
                        || !Number.isSafeInteger(result.ignored) || result.ignored < 0
                        || !Number.isSafeInteger(result.stale) || result.stale < 0 || typeof result.version !== 'string') {
                        throw new Error('Niepoprawne potwierdzenie synchronizacji; pakiet zostanie ponowiony.');
                    }
                    added += result.added; ignored += result.ignored; stale += result.stale;
                    if (stale) break;
                    // The server limits request frequency per reporter.
                    if (i + 50 < records.length) await new Promise(resolve => setTimeout(resolve, 1100));
                }
                if (!stale) acknowledged = digest; // Never acknowledge a partial/failed/stale import.
                return { added, ignored, stale, records: records.length };
            } finally { running = false; }
        },
        config,
    };
}

async function main() {
    const path = process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'ranking-companion.json';
    const config = JSON.parse((await fs.readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
    const companion = createCompanion(config);
    const once = process.argv.includes('--once');
    console.log('Ranking sync: oczekiwanie na zapis gry po /reload lub wylogowaniu.');
    do {
        try {
            const result = await companion.sync();
            if (result.stale) {
                console.error(`Zatrzymano: ${result.stale} liczników jest starszych od zapisanych w rankingu. `
                    + `W tej próbie dodano ${result.added}, pominięto ${result.ignored}. `
                    + 'Sprawdź kopię SavedVariables z administratorem (docs/ranking-sync.md). Nie usuwaj rejestru importów.');
                process.exitCode = 2;
                return;
            }
            if (!result.unchanged) console.log(result.records
                ? `GitHub potwierdzony: dodano ${result.added}, pominięto ${result.ignored}, wpisów ${result.records}.`
                : 'Brak zapisanych danych wybranych postaci. Włącz /hl rankingsync on, potem /reload po zabójstwie.');
        } catch (error) {
            console.error('Nie zsynchronizowano:', error.message);
            if (once) { process.exitCode = 1; return; }
        }
        if (!once) await new Promise(resolve => setTimeout(resolve, companion.config.intervalSeconds * 1000));
    } while (!once);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createCompanion, validateConfig };
