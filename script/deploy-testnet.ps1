# Deploys Levy (FeeRouter + SubscriptionManager) to Arc testnet with forge.
#
# Run it from any PowerShell window:
#   powershell -ExecutionPolicy Bypass -File D:\REPO\levy\script\deploy-testnet.ps1
# If forge is not on PATH, say where Foundry's binaries are:
#   powershell -ExecutionPolicy Bypass -File D:\REPO\levy\script\deploy-testnet.ps1 -Foundry 'C:\path\to\foundry\bin'
#
# It asks for exactly two things, both from the same `cast wallet new` output:
#   1. the deployer's PRIVATE KEY  (the "Private key: 0x..." line; hidden as you paste)
#   2. the deployer's ADDRESS      (the "Address: 0x..." line; it also becomes the fee treasury)
# The key is checked, used for this one forge run, then cleared. It is never printed.
param(
    [string]$Foundry = "",
    [switch]$Legacy,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Rpc = "https://rpc.testnet.arc.io"
$MinBalance = 0.3   # USDC; the deploy costs about 0.11

function Find-Tool([string]$name) {
    if ($Foundry) {
        $p = Join-Path $Foundry "$name.exe"
        if (Test-Path $p) { return $p }
        throw "No $name.exe in '$Foundry'."
    }
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $p = Join-Path $env:USERPROFILE ".foundry\bin\$name.exe"
    if (Test-Path $p) { return $p }
    throw "Cannot find $name. Run again with -Foundry 'folder that holds forge.exe and cast.exe'."
}

function Stop-WithMessage([string]$msg) {
    Write-Host ""
    Write-Host "STOPPED: $msg" -ForegroundColor Red
    Write-Host "Nothing was sent to the chain."
    Read-Host "Press Enter to close" | Out-Null
    exit 1
}

try {
    $forge = Find-Tool "forge"
    $cast = Find-Tool "cast"
} catch {
    Stop-WithMessage $_.Exception.Message
}

Set-Location (Join-Path $PSScriptRoot "..")
Write-Host "Levy testnet deploy (Arc testnet, chain 5042002)"
Write-Host "Repo:  $(Get-Location)"
Write-Host "Forge: $forge"
Write-Host ""

# --- 1. private key ---
Write-Host "STEP 1 of 2: paste the DEPLOYER wallet's PRIVATE KEY" -ForegroundColor Cyan
Write-Host "  From 'cast wallet new', the line that starts 'Private key:'. Paste only the 0x... value."
Write-Host "  Nothing shows while you paste. Then press Enter."
$secure = Read-Host "Deployer private key" -AsSecureString
$key = [System.Net.NetworkCredential]::new("", $secure).Password.Trim()
Remove-Variable secure
if ($key -and -not $key.StartsWith("0x")) { $key = "0x" + $key }
if ($key -match '^0x[0-9a-fA-F]{40}$') {
    Stop-WithMessage "That was an ADDRESS (40 hex characters), not the private key. The private key is 64 hex characters."
}
if ($key -notmatch '^0x[0-9a-fA-F]{64}$') {
    Stop-WithMessage "That is not a private key: expected 0x followed by 64 hex characters, got $($key.Length) characters."
}
Write-Host "  OK: private key accepted (not shown)." -ForegroundColor Green
Write-Host ""

# --- 2. address ---
Write-Host "STEP 2 of 2: paste the DEPLOYER wallet's ADDRESS" -ForegroundColor Cyan
Write-Host "  From the same 'cast wallet new' output, the line that starts 'Address:'."
Write-Host "  It also becomes the treasury that receives the 1% fees on testnet."
$address = (Read-Host "Deployer address").Trim()
if ($address -notmatch '^0x[0-9a-fA-F]{40}$') {
    Stop-WithMessage "That is not an address: expected 0x followed by 40 hex characters."
}

# The key must belong to this address; forge would otherwise try to pay from another wallet.
$derived = (& $cast wallet address --private-key $key).Trim()
if ($derived.ToLower() -ne $address.ToLower()) {
    Stop-WithMessage "The private key belongs to $derived, not to $address. Use the key and address from the same wallet."
}
$balance = [double]((& $cast balance $address --rpc-url $Rpc --ether).Trim())
if ($balance -lt $MinBalance) {
    Stop-WithMessage "$address holds $balance USDC on Arc testnet; it needs at least $MinBalance. Use faucet.circle.com (Arc Testnet)."
}
Write-Host "  OK: key matches $address, which holds $balance testnet USDC." -ForegroundColor Green
Write-Host ""

# --- deploy ---
$env:DEPLOYER_PRIVATE_KEY = $key
$env:LEVY_TREASURY = $address
Remove-Variable key
$forgeArgs = @("script", "script/Deploy.s.sol", "--rpc-url", "arc_testnet")
if (-not $DryRun) { $forgeArgs += "--broadcast" }
if ($Legacy) { $forgeArgs += "--legacy" }
Write-Host "Running: forge $($forgeArgs -join ' ')" -ForegroundColor Cyan
try {
    & $forge @forgeArgs
    $code = $LASTEXITCODE
} finally {
    Remove-Item Env:DEPLOYER_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:LEVY_TREASURY -ErrorAction SilentlyContinue
}

Write-Host ""
if ($code -ne 0) {
    Write-Host "forge failed (exit code $code). If the error mentions fees or gas price, run this script again with -Legacy." -ForegroundColor Red
} elseif ($DryRun) {
    Write-Host "Dry run passed. Run again without -DryRun to deploy." -ForegroundColor Green
} else {
    Write-Host "Deployed. Tell Claude it's done; the addresses are in broadcast\Deploy.s.sol\5042002\run-latest.json." -ForegroundColor Green
}
Read-Host "Press Enter to close" | Out-Null
exit $code
