param(
    [int]$Port = 18181,
    [switch]$SkipTypeCheck
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OpentrideRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$TripilotRoot = Resolve-Path (Join-Path $OpentrideRoot "..\Tripilot")
$ReportDir = Join-Path $OpentrideRoot "docs\acceptance\reports\daily"
$Now = Get-Date
$Stamp = $Now.ToString('yyyyMMdd-HHmmss')
$JsonReport = Join-Path $ReportDir "$Stamp-daily-smoke.json"
$TxtReport = Join-Path $ReportDir "$Stamp-daily-smoke.txt"

New-Item -ItemType Directory -Path $ReportDir -Force | Out-Null

$results = @()

function Add-Result {
    param(
        [string]$Id,
        [string]$Name,
        [bool]$Passed,
        [string]$Detail
    )

    $script:results += [pscustomobject]@{
        id = $Id
        name = $Name
        passed = $Passed
        detail = $Detail
    }
}

function Assert-Contains {
    param(
        [string]$Path,
        [string[]]$Needles
    )

    if (-not (Test-Path $Path)) {
        return [pscustomobject]@{ ok = $false; detail = "File not found: $Path" }
    }

    $content = Get-Content -Path $Path -Raw -Encoding UTF8
    $missing = @()
    foreach ($n in $Needles) {
        if ($content -notmatch [regex]::Escape($n)) {
            $missing += $n
        }
    }

    if ($missing.Count -gt 0) {
        return [pscustomobject]@{ ok = $false; detail = "Missing: " + ($missing -join ', ') }
    }

    return [pscustomobject]@{ ok = $true; detail = "Matched $($Needles.Count) keys" }
}

# C1: health checks
try {
    $cmd = Get-Command opencode -ErrorAction Stop
    $docUri = ('http://127.0.0.1:{0}/doc' -f $Port)
    $eventUri = ('http://127.0.0.1:{0}/event' -f $Port)
    $docResp = Invoke-WebRequest -UseBasicParsing -Uri $docUri -Method GET -TimeoutSec 10
    $docCode = [string]$docResp.StatusCode
    $eventResp = Invoke-WebRequest -UseBasicParsing -Uri $eventUri -Method Head -TimeoutSec 10
    $eventType = [string]$eventResp.Headers['Content-Type']
    $eventOk = ($eventType -match 'text/event-stream')

    $ok = ($docCode -eq '200') -and $eventOk
    $detail = "opencode=$($cmd.Name); /doc=$docCode; /event=$eventType"
    Add-Result -Id "C1" -Name "Health" -Passed $ok -Detail $detail
}
catch {
    Add-Result -Id "C1" -Name "Health" -Passed $false -Detail $_.Exception.Message
}

# C2: TypeScript compile health
if ($SkipTypeCheck) {
    Add-Result -Id "C2" -Name "TypeCheck" -Passed $true -Detail "Skipped (--SkipTypeCheck)"
}
else {
    try {
        Push-Location $TripilotRoot
        try {
            $output = & npx tsc -p tsconfig.json --noEmit 2>&1
            $exitCode = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }

        $ok = ($exitCode -eq 0)
        $detail = if ($ok) { "tsc --noEmit passed" } else { "tsc failed: " + (($output | Select-Object -First 6) -join " | ") }
        Add-Result -Id "C2" -Name "TypeCheck" -Passed $ok -Detail $detail
    }
    catch {
        Add-Result -Id "C2" -Name "TypeCheck" -Passed $false -Detail $_.Exception.Message
    }
}

# C3: debug command availability (source assertions)
try {
    $pkgPath = Join-Path $TripilotRoot "package.json"
    $extPath = Join-Path $TripilotRoot "src\extension.ts"

    $pkgCheck = Assert-Contains -Path $pkgPath -Needles @(
        'tripilot.debug.mockPermission',
        'tripilot.debug.mockQuestion'
    )
    $extCheck = Assert-Contains -Path $extPath -Needles @(
        "registerCommand('tripilot.debug.mockPermission'",
        "registerCommand('tripilot.debug.mockQuestion'"
    )

    $ok = $pkgCheck.ok -and $extCheck.ok
    $detail = "package.json: $($pkgCheck.detail); extension.ts: $($extCheck.detail)"
    Add-Result -Id "C3" -Name "DebugCommands" -Passed $ok -Detail $detail
}
catch {
    Add-Result -Id "C3" -Name "DebugCommands" -Passed $false -Detail $_.Exception.Message
}

# C4: key output text assertions (source assertions)
try {
    $extPath = Join-Path $TripilotRoot "src\extension.ts"
    $check = Assert-Contains -Path $extPath -Needles @(
        'Mock Permission',
        'Mock Question',
        'received',
        'cancelled'
    )
    Add-Result -Id "C4" -Name "OutputText" -Passed $check.ok -Detail $check.detail
}
catch {
    Add-Result -Id "C4" -Name "OutputText" -Passed $false -Detail $_.Exception.Message
}

# C5: progress flow assertions (source assertions)
try {
    $mainJsPath = Join-Path $TripilotRoot "media\main.js"
    $check = Assert-Contains -Path $mainJsPath -Needles @(
        'function ensureProgressGroup()',
        'function upsertProgressItem(msg)',
        "case 'chatProgress':",
        'toolStatus-running',
        'toolStatus-ok',
        'toolStatus-error'
    )
    Add-Result -Id "C5" -Name "ProgressFlow" -Passed $check.ok -Detail $check.detail
}
catch {
    Add-Result -Id "C5" -Name "ProgressFlow" -Passed $false -Detail $_.Exception.Message
}

$passCount = ($results | Where-Object { $_.passed }).Count
$total = $results.Count
$allPassed = ($passCount -eq $total)
$status = if ($allPassed) { 'PASS' } else { 'FAIL' }

$summary = [pscustomobject]@{
    status = $status
    passCount = $passCount
    total = $total
    generatedAt = $Now.ToString('yyyy-MM-dd HH:mm:ss')
    port = $Port
    checks = $results
}

$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $JsonReport -Encoding UTF8

$lines = @()
$lines += "Tripilot Daily Smoke: $status ($passCount/$total)"
$lines += "GeneratedAt: $($summary.generatedAt)"
$lines += "Port: $Port"
$lines += ""
foreach ($r in $results) {
    $flag = if ($r.passed) { 'PASS' } else { 'FAIL' }
    $lines += "[$($r.id)] $($r.name): $flag"
    $lines += "  - $($r.detail)"
}
$lines += ""
$lines += "JSON: $JsonReport"
$lines += "TXT : $TxtReport"
$lines | Set-Content -Path $TxtReport -Encoding UTF8

Write-Host "Tripilot Daily Smoke: $status ($passCount/$total)"
Write-Host "JSON: $JsonReport"
Write-Host "TXT : $TxtReport"

if (-not $allPassed) {
    exit 1
}

exit 0
