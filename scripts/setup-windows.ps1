$ErrorActionPreference = 'Stop'
try {
    if ($env:SMOLUP_SETUP_COLOR -eq '1') {
        Write-Host 'Paste the complete Smolish Cookie header (name=value; name=value).' -ForegroundColor DarkGray
    } else { Write-Host 'Paste the complete Smolish Cookie header (name=value; name=value).' }
    if ($env:SMOLUP_SETUP_COLOR -eq '1') {
        Write-Host 'Cookie (input hidden): ' -NoNewline -ForegroundColor Cyan
        $smolupSecret = Read-Host -AsSecureString
    } else { $smolupSecret = Read-Host 'Cookie (input hidden)' -AsSecureString }
    $smolupText = ([System.Net.NetworkCredential]::new('', $smolupSecret)).Password.Trim()
    $smolupText = $smolupText -replace '^Cookie:\s*', ''
    if (!$smolupText.Contains('=') -or $smolupText -match '[\r\n\x00]') {
        throw 'Use a complete Cookie header.'
    }
    $smolupSecret = ConvertTo-SecureString $smolupText -AsPlainText -Force
    $smolupRecord = @{ protection = 'windows-dpapi'; encrypted = ConvertFrom-SecureString $smolupSecret }
    $smolupTemporary = $env:SMOLUP_AUTH_DESTINATION + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($smolupTemporary, ($smolupRecord | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $smolupTemporary -Destination $env:SMOLUP_AUTH_DESTINATION -Force
    if ($env:SMOLUP_SETUP_COLOR -eq '1') {
        Write-Host 'Cookie encrypted and saved for this Windows user.' -ForegroundColor Green
    } else { Write-Host 'Cookie encrypted and saved for this Windows user.' }
} catch {
    Write-Error 'Cookie setup failed. No cookie was printed.'
    exit 1
} finally {
    if ($smolupTemporary -and [IO.File]::Exists($smolupTemporary)) { Remove-Item -LiteralPath $smolupTemporary -Force }
    $smolupText = $null
    $smolupSecret = $null
}
