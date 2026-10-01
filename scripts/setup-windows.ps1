$ErrorActionPreference = 'Stop'
try {
    if ($env:SMUP_SETUP_COLOR -eq '1') {
        Write-Host 'Paste the complete Smolish Cookie header (name=value; name=value).' -ForegroundColor DarkGray
    } else { Write-Host 'Paste the complete Smolish Cookie header (name=value; name=value).' }
    if ($env:SMUP_SETUP_COLOR -eq '1') {
        Write-Host 'Cookie (input hidden): ' -NoNewline -ForegroundColor Cyan
        $smupSecret = Read-Host -AsSecureString
    } else { $smupSecret = Read-Host 'Cookie (input hidden)' -AsSecureString }
    $smupText = ([System.Net.NetworkCredential]::new('', $smupSecret)).Password.Trim()
    $smupText = $smupText -replace '^Cookie:\s*', ''
    if (!$smupText.Contains('=') -or $smupText -match '[\r\n\x00]') {
        throw 'Use a complete Cookie header.'
    }
    $smupSecret = ConvertTo-SecureString $smupText -AsPlainText -Force
    $smupRecord = @{ protection = 'windows-dpapi'; encrypted = ConvertFrom-SecureString $smupSecret }
    $smupTemporary = $env:SMUP_AUTH_DESTINATION + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($smupTemporary, ($smupRecord | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $smupTemporary -Destination $env:SMUP_AUTH_DESTINATION -Force
    if ($env:SMUP_SETUP_COLOR -eq '1') {
        Write-Host 'Cookie encrypted and saved for this Windows user.' -ForegroundColor Green
    } else { Write-Host 'Cookie encrypted and saved for this Windows user.' }
} catch {
    Write-Error 'Cookie setup failed. No cookie was printed.'
    exit 1
} finally {
    if ($smupTemporary -and [IO.File]::Exists($smupTemporary)) { Remove-Item -LiteralPath $smupTemporary -Force }
    $smupText = $null
    $smupSecret = $null
}
