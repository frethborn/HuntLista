// Kept in the same GitHub file/commit as the counters. Lua/updaters ignore this
// comment, but every writer must preserve it to make retrying imports safe.
const PREFIX = '-- HuntListaSyncLedger v1: ';
const MAX_ENTRIES = 4096;

function validateLedger(ledger) {
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)
        || Object.keys(ledger).length > MAX_ENTRIES
        || Object.entries(ledger).some(([key, value]) => !/^[a-f0-9]{64}$/.test(key)
            || !Number.isInteger(value) || value < 1 || value > 1e9)) {
        throw new Error('Niepoprawny lub pełny rejestr synchronizacji. Zapis zablokowany.');
    }
    return ledger;
}

function readLedger(content) {
    const lines = content.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).map(line => line.trimStart())
        .filter(line => /^--\s*HuntListaSyncLedger\b/i.test(line));
    if (!lines.length) return Object.create(null);
    if (lines.length !== 1 || !lines[0].startsWith(PREFIX)) throw new Error('Niepoprawny rejestr synchronizacji.');
    const raw = lines[0].slice(PREFIX.length);
    const ledger = validateLedger(JSON.parse(raw));
    // Also reject duplicate JSON keys instead of accepting a lower watermark.
    if (JSON.stringify(ledger) !== raw) throw new Error('Niejednoznaczny rejestr synchronizacji.');
    return ledger;
}

function writeLedger(ledger) {
    validateLedger(ledger);
    return Object.keys(ledger).length ? PREFIX + JSON.stringify(ledger) + '\n' : '';
}

module.exports = { readLedger, writeLedger };
