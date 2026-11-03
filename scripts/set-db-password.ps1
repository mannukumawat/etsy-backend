# Sets the password inside DATABASE_URL in backend/.env.
#
# Prompts for the password (hidden), percent-encodes it correctly, and rewrites ONLY the
# DATABASE_URL line. The password is never echoed, never passed as an argument, and never
# written to your PowerShell history.
#
# Usage, from the backend/ folder:
#   powershell -ExecutionPolicy Bypass -File .\scripts\set-db-password.ps1

$ErrorActionPreference = 'Stop'

$envPath = Join-Path $PSScriptRoot '..\.env'
$envPath = [System.IO.Path]::GetFullPath($envPath)

if (-not (Test-Path $envPath)) {
    Write-Host "No .env found at $envPath" -ForegroundColor Red
    Write-Host "Create it first:  Copy-Item .env.example .env"
    exit 1
}

# Defaults match the setup guide; press Enter to accept.
$user = Read-Host "Database user [yourstore]"
if ([string]::IsNullOrWhiteSpace($user)) { $user = 'yourstore' }

$dbHost = Read-Host "Host [localhost]"
if ([string]::IsNullOrWhiteSpace($dbHost)) { $dbHost = 'localhost' }

$port = Read-Host "Port [5432]"
if ([string]::IsNullOrWhiteSpace($port)) { $port = '5432' }

$database = Read-Host "Database [yourstore_dev]"
if ([string]::IsNullOrWhiteSpace($database)) { $database = 'yourstore_dev' }

$secure = Read-Host "Password for '$user'" -AsSecureString
$plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
)

if ([string]::IsNullOrEmpty($plain)) {
    Write-Host "No password entered. Nothing changed." -ForegroundColor Yellow
    exit 1
}

# Uri::EscapeDataString percent-encodes every character that is unsafe in a URL,
# so @ : / ? # [ ] % & and spaces are all handled for you.
$encoded = [System.Uri]::EscapeDataString($plain)
$url = "postgresql://${user}:${encoded}@${dbHost}:${port}/${database}?schema=public"

$lines = Get-Content $envPath
$found = $false
$out = foreach ($line in $lines) {
    if ($line -match '^\s*DATABASE_URL\s*=') {
        $found = $true
        "DATABASE_URL=`"$url`""
    } else {
        $line
    }
}
if (-not $found) { $out += "DATABASE_URL=`"$url`"" }

Set-Content -Path $envPath -Value $out -Encoding UTF8

# Clear the plaintext from memory as soon as we are done with it.
$plain = $null
[System.GC]::Collect()

Write-Host ""
Write-Host "Updated DATABASE_URL in $envPath" -ForegroundColor Green
Write-Host "  user     $user"
Write-Host "  host     ${dbHost}:${port}"
Write-Host "  database $database"
Write-Host "  password (hidden, percent-encoded automatically)"
Write-Host ""
Write-Host "Next:  npm run setup   then   npm run dev"
