# Upload project + run installer on the VPS. The server only accepts SSH keys (no password).
#   powershell -ExecutionPolicy Bypass -File .\deploy\deploy-windows.ps1                 (OpenSSH, ~/.ssh key / ssh-agent)
#   powershell -ExecutionPolicy Bypass -File .\deploy\deploy-windows.ps1 -Key C:\k.ppk   (PuTTY .ppk)
#   powershell -ExecutionPolicy Bypass -File .\deploy\deploy-windows.ps1 -Key C:\id_ed25519  (OpenSSH key)
#   powershell -ExecutionPolicy Bypass -File .\deploy\deploy-windows.ps1 -Session "nama-session-putty"
# Options: -Server 1.2.3.4  -User root  -Port 22
param(
  [string]$Server = "45.66.153.150",
  [string]$User = "root",
  [int]$Port = 22,
  [string]$Key = "",
  [string]$Session = ""
)
$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $PSScriptRoot
$target = "${User}@${Server}"

# Pack only the source (no node_modules/build/.env/data) into one small archive
$archive = Join-Path $env:TEMP "asuransi-gempa.tgz"
Write-Host "==> Paket $src"
& tar.exe -czf $archive -C $src --exclude=node_modules --exclude=build --exclude=.env --exclude=data --exclude=agent/data .
if ($LASTEXITCODE -ne 0) { throw "tar gagal (exit $LASTEXITCODE)" }
Write-Host ("   {0:N0} KB" -f ((Get-Item $archive).Length / 1KB))

$remote = "rm -rf ~/asuransi-gempa && mkdir -p ~/asuransi-gempa && tar -xzf ~/asuransi-gempa.tgz -C ~/asuransi-gempa && rm ~/asuransi-gempa.tgz && bash ~/asuransi-gempa/deploy/install.sh"

# PuTTY when a .ppk or a PuTTY session is given, otherwise Windows OpenSSH
$usePutty = ($Key -like "*.ppk") -or $Session
if ($usePutty) {
  function Find-Tool($name) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($d in @("$env:ProgramFiles\PuTTY", "${env:ProgramFiles(x86)}\PuTTY")) {
      if (Test-Path "$d\$name.exe") { return "$d\$name.exe" }
    }
    throw "$name.exe tidak ditemukan. Install PuTTY lengkap (termasuk pscp & plink)."
  }
  $auth = if ($Session) { @("-load", $Session) } else { @("-i", $Key, "-P", $Port) }
  Write-Host "`n==> Upload ke $target (PuTTY)"
  & (Find-Tool "pscp") @auth $archive "${target}:asuransi-gempa.tgz"
  if ($LASTEXITCODE -ne 0) { throw "Upload gagal (pscp exit $LASTEXITCODE)" }
  Write-Host "`n==> Jalankan installer di VPS"
  & (Find-Tool "plink") @auth -t $target $remote
} else {
  if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) { throw "ssh.exe (OpenSSH) tidak ada. Pakai -Key file.ppk untuk PuTTY." }
  $auth = @("-o", "StrictHostKeyChecking=accept-new")
  if ($Key) { $auth += @("-i", $Key) }
  Write-Host "`n==> Upload ke $target (OpenSSH)"
  & scp.exe @auth -P $Port $archive "${target}:asuransi-gempa.tgz"
  if ($LASTEXITCODE -ne 0) { throw "Upload gagal (scp exit $LASTEXITCODE). Key belum terdaftar? Coba -Key path\ke\key" }
  Write-Host "`n==> Jalankan installer di VPS"
  & ssh.exe @auth -p $Port -t $target $remote
}
Write-Host "`nSelesai (exit $LASTEXITCODE)."
