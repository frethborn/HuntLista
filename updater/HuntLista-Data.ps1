# Canonical helper. Keep auto-updater/HuntLista-Data.ps1 identical so each updater
# folder can be copied on its own. Tests verify both copies and the data contract.
if (-not ('HuntLista.UpdateDataParser' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace HuntLista {
    public sealed class UpdateDataInfo {
        public string Version;
        public string LastUpdate;
        public int PlayerCount;
    }

    // Reads only the literal data format accepted by HuntListaBot/data.js.
    // No Lua interpreter, expression evaluation, file access or network access.
    public sealed class UpdateDataParser {
        private readonly string text;
        private int pos;
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        private static readonly HashSet<string> Reserved = new HashSet<string>(
            "and break do else elseif end false for function if in local nil not or repeat return then true until while".Split(' '));

        private UpdateDataParser(string value) { text = value; }
        private FormatException Invalid() { return new FormatException("Niepoprawny format Data.lua (pozycja " + pos + ")."); }
        private char Current { get { return pos < text.Length ? text[pos] : '\0'; } }
        private bool Starts(string value) {
            return pos + value.Length <= text.Length && String.CompareOrdinal(text, pos, value, 0, value.Length) == 0;
        }
        private static bool Letter(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; }
        private static bool Digit(char c) { return c >= '0' && c <= '9'; }
        private bool LongStringStart() {
            if (Current != '[') return false;
            int end = pos + 1;
            while (end < text.Length && text[end] == '=') end++;
            return end < text.Length && text[end] == '[';
        }
        private string LongString() {
            int start = ++pos;
            while (Current == '=') pos++;
            string close = "]" + text.Substring(start, pos - start) + "]";
            if (Current != '[') throw Invalid();
            start = ++pos;
            int end = text.IndexOf(close, start, StringComparison.Ordinal);
            if (end < 0) throw Invalid();
            string result = Regex.Replace(text.Substring(start, end - start), "\r\n|\n\r|\r", "\n");
            if (result.StartsWith("\n", StringComparison.Ordinal)) result = result.Substring(1);
            pos = end + close.Length;
            return result;
        }
        private void Skip() {
            while (pos < text.Length) {
                if (" \t\r\n\v\f".IndexOf(Current) >= 0) { pos++; continue; }
                if (!Starts("--")) break;
                pos += 2;
                if (LongStringStart()) LongString();
                else while (pos < text.Length && Current != '\r' && Current != '\n') pos++;
            }
        }
        private bool Eat(char value) {
            Skip();
            if (pos >= text.Length || Current != value) return false;
            pos++;
            return true;
        }
        private void Expect(char value) { if (!Eat(value)) throw Invalid(); }
        private string Identifier() {
            Skip();
            if (!Letter(Current)) throw Invalid();
            int start = pos++;
            while (Letter(Current) || Digit(Current)) pos++;
            string result = text.Substring(start, pos - start);
            if (Reserved.Contains(result)) throw Invalid();
            return result;
        }
        private string StringValue() {
            Skip();
            if (LongStringStart()) return LongString();
            char quote = Current;
            if (quote != '\'' && quote != '"') throw Invalid();
            pos++;
            var bytes = new List<byte>();
            var literal = new StringBuilder();
            while (pos < text.Length) {
                char c = text[pos++];
                if (c == quote) {
                    bytes.AddRange(Utf8.GetBytes(literal.ToString()));
                    try { return Utf8.GetString(bytes.ToArray()); }
                    catch (DecoderFallbackException) { throw Invalid(); }
                }
                if (c == '\r' || c == '\n') throw Invalid();
                if (c != '\\') { literal.Append(c); continue; }
                bytes.AddRange(Utf8.GetBytes(literal.ToString()));
                literal.Length = 0;
                if (pos >= text.Length) throw Invalid();
                c = text[pos++];
                if (Digit(c)) {
                    int value = c - '0';
                    for (int n = 1; n < 3 && Digit(Current); n++) value = value * 10 + text[pos++] - '0';
                    if (value > 255) throw Invalid();
                    bytes.Add((byte)value);
                } else if (c == '\r' || c == '\n') {
                    if ((c == '\r' && Current == '\n') || (c == '\n' && Current == '\r')) pos++;
                    bytes.Add(10);
                } else {
                    switch (c) {
                        case 'a': bytes.Add(7); break;
                        case 'b': bytes.Add(8); break;
                        case 'f': bytes.Add(12); break;
                        case 'n': bytes.Add(10); break;
                        case 'r': bytes.Add(13); break;
                        case 't': bytes.Add(9); break;
                        case 'v': bytes.Add(11); break;
                        case '\\': case '\'': case '"': bytes.Add((byte)c); break;
                        default: throw Invalid();
                    }
                }
            }
            throw Invalid();
        }
        private Dictionary<string, object> Table(int depth) {
            if (depth > 2) throw Invalid();
            Expect('{');
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            if (Eat('}')) return result;
            while (true) {
                string key;
                if (Eat('[')) { key = StringValue(); Expect(']'); }
                else key = Identifier();
                Expect('=');
                Skip();
                object value = Current == '{' ? (object)Table(depth + 1) : StringValue();
                if (result.ContainsKey(key)) throw Invalid();
                result.Add(key, value);
                if (Eat('}')) return result;
                if (!Eat(',') && !Eat(';')) throw Invalid();
                if (Eat('}')) return result;
            }
        }
        public static UpdateDataInfo Parse(string value) {
            if (value == null || Utf8.GetByteCount(value) > 1024 * 1024) throw new FormatException("Data.lua jest pusty lub zbyt duzy.");
            var parser = new UpdateDataParser(value.TrimStart('\uFEFF'));
            if (parser.Identifier() != "HuntLista_Data") throw parser.Invalid();
            parser.Expect('=');
            var data = parser.Table(0);
            while (parser.Eat(';')) {}
            if (parser.Identifier() != "HuntLista_Lookup") throw parser.Invalid();
            parser.Expect('=');
            if (parser.Table(0).Count != 0) throw parser.Invalid();
            while (parser.Eat(';')) {}
            parser.Skip();
            if (parser.pos != parser.text.Length || data.Count != 4) throw parser.Invalid();
            foreach (string field in new [] { "version", "lastUpdate", "updatedBy" }) {
                if (!data.ContainsKey(field) || !(data[field] is string)) throw parser.Invalid();
            }
            if (!data.ContainsKey("players")) throw parser.Invalid();
            var players = data["players"] as Dictionary<string, object>;
            if (players == null) throw parser.Invalid();
            var allowed = new HashSet<string>(new [] { "reason", "addedBy", "addedAt", "note", "kills", "lastKillBy", "lastKillAt" });
            foreach (var entry in players) {
                if (String.IsNullOrWhiteSpace(entry.Key)) throw parser.Invalid();
                var fields = entry.Value as Dictionary<string, object>;
                if (fields == null) throw parser.Invalid();
                foreach (var field in fields) {
                    if (!allowed.Contains(field.Key) || !(field.Value is string)) throw parser.Invalid();
                }
            }
            return new UpdateDataInfo { Version = (string)data["version"], LastUpdate = (string)data["lastUpdate"], PlayerCount = players.Count };
        }
    }
}
'@
}

function Save-HuntListaData {
    param([Parameter(Mandatory = $true)][string]$Content, [Parameter(Mandatory = $true)][string]$TargetPath)
    $ErrorActionPreference = 'Stop'
    $info = [HuntLista.UpdateDataParser]::Parse($Content)
    $target = [System.IO.Path]::GetFullPath($TargetPath)
    $directory = [System.IO.Path]::GetDirectoryName($target)
    if (-not [System.IO.Directory]::Exists($directory)) { throw 'Folder addona nie istnieje.' }
    $stage = Join-Path $directory ('.HuntLista-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    try {
        $backup = $null
        if ([System.IO.File]::Exists($target)) {
            # I/O failures abort the update; only invalid data is excluded from the backup.
            $oldBytes = [System.IO.File]::ReadAllBytes($target)
            try {
                $oldContent = $utf8.GetString($oldBytes)
                [void][HuntLista.UpdateDataParser]::Parse($oldContent)
                if ($oldContent -ceq $Content) { return $info }
                $backup = $target + '.bak'
            } catch [System.FormatException] {
                # Preserve an existing good backup when repairing invalid local data.
            } catch [System.Text.DecoderFallbackException] {
                # Invalid UTF-8 is not a backup candidate either.
            }
        }
        [System.IO.File]::WriteAllText($stage, $Content.TrimStart([char]0xFEFF), $utf8)
        if ([System.IO.File]::Exists($target)) {
            # Same-directory replacement is atomic. Do not fall back to truncating the live file.
            if ($backup) {
                [System.IO.File]::Replace($stage, $target, $backup)
            } else {
                [System.IO.File]::Replace($stage, $target, [NullString]::Value)
            }
        } else {
            [System.IO.File]::Move($stage, $target)
        }
        return $info
    } finally {
        if ([System.IO.File]::Exists($stage)) { [System.IO.File]::Delete($stage) }
    }
}

function Update-HuntListaData {
    param([Parameter(Mandatory = $true)][string]$Uri, [Parameter(Mandatory = $true)][string]$TargetPath)
    $ErrorActionPreference = 'Stop'
    $directory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($TargetPath))
    $download = Join-Path $directory ('.HuntLista-download-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 25 -OutFile $download -ErrorAction Stop | Out-Null
        if ((Get-Item -LiteralPath $download -ErrorAction Stop).Length -gt 1MB) { throw 'Data.lua jest zbyt duzy.' }
        $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
        $content = $utf8.GetString([System.IO.File]::ReadAllBytes($download))
        Save-HuntListaData -Content $content -TargetPath $TargetPath
    } finally {
        if ([System.IO.File]::Exists($download)) { [System.IO.File]::Delete($download) }
    }
}
