const http = require('node:http');
const fs = require('node:fs');
const { createHash, timingSafeEqual } = require('node:crypto');
const { importRanking, validateRecord, validGUID, validName } = require('./ranking-sync');
const BODY_LIMIT = 64 * 1024;
const hash = text => createHash('sha256').update(text).digest();

function validateReporters(reporters) {
    if (!Array.isArray(reporters) || !reporters.length || reporters.length > 256) throw new Error('Brak poprawnej listy reporterów.');
    const ids = new Set(), tokens = new Set(), guids = new Set();
    return reporters.map(reporter => {
        if (!reporter || !/^[A-Za-z0-9_-]{1,64}$/.test(reporter.id || '')
            || typeof reporter.token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(reporter.token)
            || ids.has(reporter.id) || tokens.has(reporter.token)
            || !reporter.characters || typeof reporter.characters !== 'object' || Array.isArray(reporter.characters)
            || !Object.keys(reporter.characters).length || Object.keys(reporter.characters).length > 64) {
            throw new Error('Niepoprawny lub powtórzony reporter.');
        }
        for (const [guid, label] of Object.entries(reporter.characters)) {
            if (!validGUID(guid) || !validName(label) || guids.has(guid)) throw new Error('Niepoprawna lub powtórzona postać reportera.');
            guids.add(guid);
        }
        ids.add(reporter.id); tokens.add(reporter.token);
        return { id: reporter.id, characters: reporter.characters, tokenHash: hash(reporter.token) };
    });
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        let size = 0, chunks = [], failed = false;
        request.on('data', chunk => {
            if (failed) return;
            size += chunk.length;
            if (size > BODY_LIMIT) {
                failed = true; chunks = [];
                reject(Object.assign(new Error('Pakiet jest za duży.'), { status: 413 }));
            } else chunks.push(chunk);
        });
        request.on('end', () => {
            if (failed) return;
            try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
            catch { reject(Object.assign(new Error('Niepoprawny JSON.'), { status: 400 })); }
        });
        request.on('error', reject);
        request.on('aborted', () => reject(new Error('Przerwane żądanie.')));
    });
}

function createRankingServer(store, config) {
    const reporters = validateReporters(config.reporters);
    const busy = new Set();
    const nextAllowed = new Map();
    const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (req, res) => {
        function reply(status, data) {
            if (res.destroyed) return;
            req.resume(); // Drain rejected bodies so clients can receive the error response.
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(data));
        }
        if (req.method !== 'POST' || req.url !== '/v1/kills') return reply(404, { error: 'Nie znaleziono.' });
        const authorization = req.headers.authorization || '';
        const supplied = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization);
        const suppliedHash = hash(supplied ? supplied[1] : '');
        const reporter = reporters.find(r => timingSafeEqual(r.tokenHash, suppliedHash));
        if (!supplied || !reporter) return reply(401, { error: 'Niepoprawny klucz synchronizacji.' });
        if (busy.has(reporter.id) || busy.size >= 16 || Date.now() < (nextAllowed.get(reporter.id) || 0)) {
            return reply(429, { error: 'Poczekaj i ponów ten sam pakiet.' });
        }
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { error: 'Wymagany JSON.' });
        if (Number(req.headers['content-length']) > BODY_LIMIT) return reply(413, { error: 'Pakiet jest za duży.' });
        busy.add(reporter.id);
        try {
            const body = await readBody(req);
            if (!body || Object.keys(body).length !== 1 || !Array.isArray(body.records)
                || !body.records.length || body.records.length > 50) return reply(400, { error: 'Niepoprawny pakiet.' });
            try { body.records.forEach(validateRecord); }
            catch { return reply(400, { error: 'Niepoprawne wpisy.' }); }
            if (body.records.some(record => !Object.hasOwn(reporter.characters, record.playerGUID))) {
                return reply(403, { error: 'Postać nie jest przypisana do tego klucza.' });
            }
            const duplicates = body.records.map(r => JSON.stringify([r.playerGUID, r.stream, r.victim]));
            if (new Set(duplicates).size !== duplicates.length) return reply(400, { error: 'Powtórzony wpis.' });
            const result = await importRanking(store, reporter, body.records);
            reply(200, result);
        } catch (error) {
            reply(error.status || 503, { error: error.status ? error.message : 'Nie potwierdzono zapisu. Ponów ten sam pakiet.' });
        } finally {
            busy.delete(reporter.id);
            nextAllowed.set(reporter.id, Date.now() + 1000);
        }
    });
    server.maxHeadersCount = 32;
    server.setTimeout(30000, socket => socket.destroy());
    return server;
}

function startRankingServer(store, configPath) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    const port = config.port ?? 3210;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Niepoprawny port synchronizacji.');
    const server = createRankingServer(store, config);
    // Only a local TLS reverse proxy should expose this endpoint to the internet.
    server.listen(port, '127.0.0.1', () => console.log(`Ranking sync: 127.0.0.1:${port}`));
    server.on('error', error => { console.error('Ranking sync:', error.code || 'błąd serwera'); process.exitCode = 1; });
    return server;
}

module.exports = { createRankingServer, startRankingServer, validateReporters };
