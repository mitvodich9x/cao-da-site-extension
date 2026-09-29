param(
    # Ghi chú bản mới — hiện trong khung "Có bản mới" của panel. Nên gõ không dấu:
    # PowerShell 5.1 hay làm hỏng chữ có dấu khi truyền qua tham số.
    [string]$Notes = "",

    [string]$Repo = "mitvodich9x/cao-da-site-extension",

    [switch]$DryRun
)

# Phát hành extension "Cào đa site":
#   1. đọc version trong extension\manifest.json (tăng version TRƯỚC khi chạy)
#   2. đóng zip thư mục extension\ (gồm cả lumi-default.js — file token không lên git)
#   3. tạo GitHub Release v<version>, đính cao-da-site-extension.zip
#   4. ghi extension.json (nút "Kiểm tra cập nhật" trong panel đọc file này) rồi commit + push
#
#   powershell -File release.ps1 -Notes "Cao da site: ..."

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Invoke-Git {
    & git @args
    if ($LASTEXITCODE -ne 0) {
        throw "git $($args -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Get-GitHubToken {
    $token = $env:GITHUB_TOKEN
    if (-not $token) {
        $token = $env:GH_TOKEN
    }
    if ($token) {
        return $token
    }

    # PowerShell 5.1 làm hỏng stdin khi pipe vào git (git credential fill báo thiếu
    # protocol), nên đưa câu hỏi qua file tạm. File tạm chỉ có protocol/host, không
    # chứa bí mật; token trả về chỉ nằm trong bộ nhớ.
    $tmpIn = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tmpIn, "protocol=https`nhost=github.com`n`n")
        $credentialOutput = & cmd.exe /c "git credential fill < `"$tmpIn`""
    }
    finally {
        Remove-Item $tmpIn -ErrorAction SilentlyContinue
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Cannot read GitHub credential from git credential helper. Set GITHUB_TOKEN first."
    }

    foreach ($line in ($credentialOutput -split "`n")) {
        if ($line -like "password=*") {
            return $line.Substring("password=".Length).Trim()
        }
    }

    throw "No GitHub token/password found. Set GITHUB_TOKEN or login Git credential helper."
}

function Invoke-GitHubJson {
    param(
        [string]$Method,
        [string]$Uri,
        [string]$Token,
        $Body = $null
    )

    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent"           = "CaoDaSiteReleaseScript"
    }

    if ($null -eq $Body) {
        return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -TimeoutSec 120
    }

    $json = $Body | ConvertTo-Json -Depth 10
    $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -Body $jsonBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 120
}

$extDir = "extension"
$zipName = "cao-da-site-extension.zip"
$infoFile = "extension.json"

$manifest = [System.IO.File]::ReadAllText((Resolve-Path "$extDir\manifest.json"), [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
$version = $manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "extension\manifest.json version must look like 1.7.1 (got '$version')"
}
$tag = "v$version"

Write-Step "Checking before release $tag"
# Thiếu file này thì zip ra không có token Lumi điền sẵn -> convert ảnh hỏng trên máy mới.
if (-not (Test-Path "$extDir\lumi-default.js")) {
    throw "Missing $extDir\lumi-default.js (Lumi token, not in git) - see README.md"
}

$dirty = git status --porcelain
if ($dirty) {
    throw "Uncommitted changes - commit them first:`n$($dirty -join "`n")"
}
Invoke-Git fetch -q origin
$behind = (git rev-list --count HEAD..origin/main).Trim()
if ($behind -ne "0") {
    throw "origin/main has $behind commit(s) this machine does not have - run 'git pull' first"
}

$parts = $Repo.Split("/")
$apiBase = "https://api.github.com/repos/$($parts[0])/$($parts[1])"
$token = Get-GitHubToken
$existing = $null
try {
    $existing = Invoke-GitHubJson -Method "Get" -Uri "$apiBase/releases/tags/$tag" -Token $token
}
catch {
    $statusCode = 0
    if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
    if ($statusCode -ne 404) { throw }
}
if ($existing) {
    throw "Release $tag already exists - bump version in extension\manifest.json first"
}

Write-Step "Packing $extDir -> release\$zipName (extension $version)"
$zipPath = Join-Path "release" $zipName
if ($DryRun) {
    Write-Host "[DryRun] Would zip $extDir, create release $tag on $Repo and update $infoFile"
    return
}

New-Item -ItemType Directory -Force -Path "release" | Out-Null
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("cds-ext-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    Get-ChildItem $extDir -File | Copy-Item -Destination $staging
    Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force
}
finally {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Step "Creating GitHub release $tag"
Invoke-Git push -q origin HEAD:main
$headSha = (git rev-parse HEAD).Trim()
$release = Invoke-GitHubJson -Method "Post" -Uri "$apiBase/releases" -Token $token -Body @{
    tag_name         = $tag
    target_commitish = $headSha
    name             = "Cao da site $version"
    body             = $Notes
}
$uploadBase = ($release.upload_url -split "\{")[0]
$uploadHeaders = @{
    Authorization          = "Bearer $token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "CaoDaSiteReleaseScript"
}
Write-Host "Uploading $zipName ..."
$uploaded = Invoke-RestMethod -Method Post -Uri "$uploadBase`?name=$zipName" `
    -Headers $uploadHeaders -InFile $zipPath -ContentType "application/zip" -TimeoutSec 600

Write-Step "Updating $infoFile"
$info = [ordered]@{
    version     = $version
    zip_url     = $uploaded.browser_download_url
    notes       = $Notes
    released_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$json = ($info | ConvertTo-Json -Depth 5) + "`n"
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot $infoFile), $json, [System.Text.UTF8Encoding]::new($false))
Invoke-Git add $infoFile
Invoke-Git commit -q -m "release: $tag"
Invoke-Git push -q origin HEAD:main

Write-Step "Release done"
Write-Host "Extension $version -> $($uploaded.browser_download_url)"
Write-Host "Latest link: https://github.com/$Repo/releases/latest/download/$zipName"
