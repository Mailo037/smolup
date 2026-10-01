$ErrorActionPreference = 'Stop'
try {
    if ($env:SMOP_SETUP_COLOR -eq '1') {
        Write-Host 'Paste the complete Smolish Cookie header (name=value; name=value).' -ForegroundColor DarkGray
    } else { Write-Host 'Paste the complete Smolish Cookie header (name=value; name=value).' }
    if ($env:SMOP_SETUP_COLOR -eq '1') {
        Write-Host 'Cookie (input hidden): ' -NoNewline -ForegroundColor Cyan
        $smopSecret = Read-Host -AsSecureString
    } else { $smopSecret = Read-Host 'Cookie (input hidden)' -AsSecureString }
    $smopText = ([System.Net.NetworkCredential]::new('', $smopSecret)).Password.Trim()
    $smopText = $smopText -replace '^Cookie:\s*', ''
    if (!$smopText.Contains('=') -or $smopText -match '[\r\n\x00]') {
        throw 'Use a complete Cookie header.'
    }
    $smopSecret = ConvertTo-SecureString $smopText -AsPlainText -Force
    $smopRecord = @{ protection = 'windows-dpapi'; encrypted = ConvertFrom-SecureString $smopSecret }
    $smopTemporary = $env:SMOP_AUTH_DESTINATION + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($smopTemporary, ($smopRecord | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $smopTemporary -Destination $env:SMOP_AUTH_DESTINATION -Force
    if ($env:SMOP_SETUP_COLOR -eq '1') {
        Write-Host 'Cookie encrypted and saved for this Windows user.' -ForegroundColor Green
    } else { Write-Host 'Cookie encrypted and saved for this Windows user.' }
} catch {
    Write-Error 'Cookie setup failed. No cookie was printed.'
    exit 1
} finally {
    if ($smopTemporary -and [IO.File]::Exists($smopTemporary)) { Remove-Item -LiteralPath $smopTemporary -Force }
    $smopText = $null
    $smopSecret = $null
}
